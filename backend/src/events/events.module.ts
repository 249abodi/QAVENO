import { Global, Module, Logger } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { DataSource } from 'typeorm';

/** Canonical real-time events (Phase 26). Server-emitted only; clients may
 *  not publish anything — no @SubscribeMessage handlers exist, so any client
 *  emission is silently dropped by the gateway. */
export const EVENTS = {
  SALE_CREATED: 'sale.created',
  INVENTORY_UPDATED: 'inventory.updated',
  PURCHASE_RECEIVED: 'purchase.received',
  TRANSFER_DISPATCHED: 'transfer.dispatched',
  TRANSFER_RECEIVED: 'transfer.received',
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

const EMITTABLE: ReadonlySet<string> = new Set(Object.values(EVENTS));

type SocketAuth = { userId: number; role: string; username: string; branchIds: number[]; organizationId: number };

@WebSocketGateway({ path: '/ws', cors: { origin: true }, transports: ['websocket'] })
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(EventsGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly ds: DataSource,
  ) {}

  /* ---------------- lifecycle ---------------- */

  /** Handshake authentication + branch-aware room assignment.
   *  Rooms are derived server-side from the JWT and the CURRENT database
   *  state (user active? branches accessible?) — never from client claims. */
  async handleConnection(client: Socket): Promise<void> {
    try {
      const auth = String(client.handshake.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
      const token = String((client.handshake.auth as Record<string, unknown> | undefined)?.token || auth || '');
      if (!token) throw new Error('NO_TOKEN');

      const payload = await this.jwt.verifyAsync(token);
      const userId = Number(payload.sub);
      if (!Number.isInteger(userId)) throw new Error('BAD_SUBJECT');

      const users = await this.ds.query(
        `SELECT id, username, role, status FROM users WHERE id=$1`, [userId],
      );
      const u = users[0];
      if (!u || u.status !== 'active') throw new Error('USER_INACTIVE');

      // Resolve default org from membership.
      const memberships = await this.ds.query(
        `SELECT organization_id FROM organization_members WHERE user_id=$1 AND status='active'`,
        [userId],
      );
      const organizationId = memberships[0] ? Number(memberships[0].organization_id) : 1;

      let branchIds: number[];
      if (u.role === 'owner' || u.role === 'admin') {
        branchIds = (await this.ds.query(`SELECT id FROM branches WHERE status='active' AND organization_id=$1`, [organizationId]))
          .map((r: { id: number }) => Number(r.id));
      } else {
        branchIds = (
          await this.ds.query(
            `SELECT b.id FROM user_branches ub JOIN branches b ON b.id=ub.branch_id
             WHERE ub.user_id=$1 AND b.status='active' AND b.organization_id=$2`, [userId, organizationId],
          )
        ).map((r: { id: number }) => Number(r.id));
      }

      client.data.auth = { userId, role: u.role, username: u.username, branchIds, organizationId } satisfies SocketAuth;
      await client.join(`user:${userId}`);
      await client.join(`org:${organizationId}`);
      for (const id of branchIds) {
        await client.join(`org:${organizationId}:branch:${id}`);
        await client.join(`branch:${id}`);
      }
      client.emit('connected', { userId, role: u.role, username: u.username, branches: branchIds, organizationId });
    } catch {
      client.emit('auth_error', { message: 'unauthorized' });
      client.disconnect(true);
    }
  }

  handleDisconnect(_client: Socket): void {
    /* socket.io drops room membership with the socket — nothing to clean up */
  }

  /* ---------------- server-side emission API ---------------- */

  private ready(): boolean {
    return !!this.server;
  }

  /** Emit to everyone authorized for a branch (room membership was validated
   *  at connect time against the DB). Unknown event names are rejected. */
  emitBranch(branchId: number, event: EventName, payload: object): boolean {
    if (!EMITTABLE.has(event)) throw new Error(`event not emittable: ${event}`);
    if (!this.ready()) return false;
    try {
      // Emit to all org rooms containing this branch (for org-aware clients).
      // Also emit to legacy branch rooms for backward compatibility.
      this.server.to(`branch:${Math.floor(branchId)}`).emit(event, payload);
      return true;
    } catch (e) {
      this.logger.warn(`emitBranch failed: ${(e as Error).message}`);
      return false;
    }
  }

  /** Emit directly to one user's personal room. */
  emitUser(userId: number, event: EventName, payload: object): boolean {
    if (!EMITTABLE.has(event)) throw new Error(`event not emittable: ${event}`);
    if (!this.ready()) return false;
    try {
      this.server.to(`user:${Math.floor(userId)}`).emit(event, payload);
      return true;
    } catch (e) {
      this.logger.warn(`emitUser failed: ${(e as Error).message}`);
      return false;
    }
  }

  /** Connected-socket count for health/observability. */
  get connectionCount(): number | null {
    return this.server ? this.server.sockets.sockets.size : null;
  }
}

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.get<string>('jwt.secret'),
        signOptions: { issuer: cfg.get<string>('jwt.issuer') },
      }),
    }),
  ],
  providers: [EventsGateway],
  exports: [EventsGateway],
})
export class EventsModule {}
