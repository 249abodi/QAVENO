import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

export interface AuditEntry {
  actorId?: number | null;
  action: string;
  entityType?: string | null;
  entityId?: number | null;
  details?: unknown;
  organizationId?: number | null;
}

/** Writes audit_log rows; when given a transactional em it joins that tx. */
@Injectable()
export class AuditService {
  async log(em: EntityManager | null, entry: AuditEntry): Promise<void> {
    const sql = `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details, organization_id)
                 VALUES ($1,$2,$3,$4,$5,$6)`;
    const params = [
      entry.actorId ?? null,
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      entry.details ? JSON.stringify(entry.details) : null,
      entry.organizationId ?? null,
    ];
    if (em) await em.query(sql, params);
  }
}
