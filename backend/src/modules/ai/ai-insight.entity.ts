import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('ai_insights')
export class AiInsight {
  @PrimaryGeneratedColumn('increment') id!: number;
  @Column({ name: 'organization_id', type: 'integer' }) organizationId!: number;
  @Column({ name: 'branch_id', type: 'integer', nullable: true }) branchId!: number | null;
  @Column({ name: 'insight_type', type: 'text' }) insightType!: string;
  @Column({ name: 'entity_type', type: 'text', nullable: true }) entityType!: string | null;
  @Column({ name: 'entity_id', type: 'integer', nullable: true }) entityId!: number | null;
  @Column({ type: 'text' }) severity!: string;
  @Column({ type: 'text' }) title!: string;
  @Column({ type: 'text', default: '' }) message!: string;
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" }) data!: Record<string, unknown>;
  @Column({ type: 'text', default: 'active' }) status!: string;
  @Column({ name: 'dismissed_at', type: 'timestamptz', nullable: true }) dismissedAt!: Date | null;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' }) createdAt!: Date;
}
