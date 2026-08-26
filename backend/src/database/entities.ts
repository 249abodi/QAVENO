import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { AiInsight } from '../modules/ai/ai-insight.entity';

/**
 * Entities mirror the SQLite schema 1:1 (snake_case columns).
 * Deliberate choice: no ORM-level relations/cascades — joins are written
 * explicitly (same style as the proven Electron SQL), keeping behavior
 * identical between local and cloud runtimes.
 */

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('increment') id!: number;
  @Column({ type: 'text' }) username!: string;
  @Column({ type: 'text', default: '' }) display_name!: string;
  @Column({ name: 'password_hash', type: 'text' }) passwordHash!: string;
  @Column({ type: 'text', default: 'cashier' }) role!: string;
  @Column({ type: 'text', default: 'active' }) status!: string;
  @Column({ name: 'must_change_password', type: 'integer', default: 0 }) mustChangePassword!: number;
  @Column({ name: 'failed_attempts', type: 'integer', default: 0 }) failedAttempts!: number;
  @Column({ name: 'locked_until', type: 'timestamptz', nullable: true }) lockedUntil!: Date | null;
  @Column({ name: 'last_login_at', type: 'timestamptz', nullable: true }) lastLoginAt!: Date | null;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' }) createdAt!: Date;
  @Column({ name: 'updated_at', type: 'timestamptz', nullable: true }) updatedAt!: Date | null;
}

@Entity('organizations')
export class Organization {
  @PrimaryGeneratedColumn('increment') id!: number;
  @Column({ type: 'text' }) name!: string;
  @Column({ type: 'text' }) slug!: string;
  @Column({ type: 'text', default: 'active' }) status!: string;
  @Column({ name: 'subscription_id', type: 'integer', nullable: true }) subscriptionId!: number | null;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' }) createdAt!: Date;
  @Column({ name: 'updated_at', type: 'timestamptz', nullable: true }) updatedAt!: Date | null;
}

@Entity('organization_members')
export class OrganizationMember {
  @Column({ name: 'user_id', type: 'integer', primary: true }) userId!: number;
  @Column({ name: 'organization_id', type: 'integer', primary: true }) organizationId!: number;
  @Column({ type: 'text', default: 'member' }) role!: string;
  @Column({ type: 'text', default: 'active' }) status!: string;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' }) createdAt!: Date;
}

@Entity('refresh_tokens')
export class RefreshToken {
  @PrimaryGeneratedColumn('increment') id!: number;
  @Column({ name: 'token_hash', type: 'text' }) tokenHash!: string;
  @Column({ name: 'user_id', type: 'integer' }) userId!: number;
  @Column({ type: 'timestamptz', default: () => 'now()' }) createdAt!: Date;
  @Column({ name: 'expires_at', type: 'timestamptz' }) expiresAt!: Date;
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true }) revokedAt!: Date | null;
}

@Entity('audit_log')
export class AuditLog {
  @PrimaryGeneratedColumn('increment') id!: number;
  @Column({ name: 'actor_id', type: 'integer', nullable: true }) actorId!: number | null;
  @Column({ type: 'text' }) action!: string;
  @Column({ name: 'entity_type', type: 'text', nullable: true }) entityType!: string | null;
  @Column({ name: 'entity_id', type: 'integer', nullable: true }) entityId!: number | null;
  @Column({ type: 'jsonb', nullable: true }) details!: unknown;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' }) createdAt!: Date;
}

@Entity('branches')
export class Branch {
  @PrimaryGeneratedColumn('increment') id!: number;
  @Column({ type: 'text' }) name!: string;
  @Column({ type: 'varchar', nullable: true }) code!: string | null;
  @Column({ type: 'text', default: '' }) address!: string;
  @Column({ type: 'text', default: '' }) phone!: string;
  @Column({ type: 'text', default: 'active' }) status!: string;
  @Column({ name: 'organization_id', type: 'integer', default: 1 }) organizationId!: number;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' }) createdAt!: Date;
  @Column({ name: 'updated_at', type: 'timestamptz', nullable: true }) updatedAt!: Date | null;
}

@Entity('user_branches')
export class UserBranch {
  @Column({ name: 'user_id', type: 'integer', primary: true }) userId!: number;
  @Column({ name: 'branch_id', type: 'integer', primary: true }) branchId!: number;
  @Column({ name: 'is_primary', type: 'integer', default: 0 }) isPrimary!: number;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' }) createdAt!: Date;
}

@Entity('categories')
export class Category {
  @PrimaryGeneratedColumn('increment') id!: number;
  @Column({ type: 'text' }) name!: string;
  @Column({ type: 'text', default: '#2563eb' }) color!: string;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' }) createdAt!: Date;
}

@Entity('products')
export class Product {
  @PrimaryGeneratedColumn('increment') id!: number;
  @Column({ type: 'text' }) name!: string;
  @Column({ type: 'text', nullable: true }) barcode!: string | null;
  @Column({ type: 'double precision' }) price!: number;
  @Column({ type: 'double precision', default: 0 }) cost!: number;
  @Column({ type: 'integer', default: 0 }) quantity!: number;
  @Column({ name: 'low_stock_threshold', type: 'integer', default: 5 }) lowStockThreshold!: number;
  @Column({ type: 'text', default: '' }) category!: string;
  @Column({ name: 'category_id', type: 'integer', nullable: true }) categoryId!: number | null;
  @Column({ name: 'reorder_qty', type: 'integer', default: 0 }) reorderQty!: number;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' }) createdAt!: Date;
  @Column({ name: 'updated_at', type: 'timestamptz', nullable: true }) updatedAt!: Date | null;
}

@Entity('suppliers')
export class Supplier {
  @PrimaryGeneratedColumn('increment') id!: number;
  @Column({ type: 'text' }) name!: string;
  @Column({ type: 'text', default: '' }) phone!: string;
  @Column({ type: 'text', default: '' }) email!: string;
  @Column({ type: 'text', default: '' }) address!: string;
  @Column({ type: 'text', default: '' }) notes!: string;
  @Column({ type: 'text', default: 'active' }) status!: string;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' }) createdAt!: Date;
  @Column({ name: 'updated_at', type: 'timestamptz', nullable: true }) updatedAt!: Date | null;
}

@Entity('purchase_orders')
export class PurchaseOrder {
  @PrimaryGeneratedColumn('increment') id!: number;
  @Column({ type: 'varchar', nullable: true }) ref!: string | null;
  @Column({ name: 'supplier_id', type: 'integer' }) supplierId!: number;
  @Column({ type: 'text', default: 'draft' }) status!: string;
  @Column({ name: 'expected_at', type: 'text', nullable: true }) expectedAt!: string | null;
  @Column({ type: 'text', default: '' }) notes!: string;
  @Column({ name: 'branch_id', type: 'integer', nullable: true }) branchId!: number | null;
  @Column({ name: 'created_by', type: 'integer', nullable: true }) createdBy!: number | null;
  @Column({ name: 'approved_by', type: 'integer', nullable: true }) approvedBy!: number | null;
  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true }) approvedAt!: Date | null;
  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true }) cancelledAt!: Date | null;
  @Column({ name: 'cancel_reason', type: 'text', default: '' }) cancelReason!: string;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' }) createdAt!: Date;
  @Column({ name: 'updated_at', type: 'timestamptz', nullable: true }) updatedAt!: Date | null;
}

@Entity('purchase_order_items')
export class PurchaseOrderItem {
  @PrimaryGeneratedColumn('increment') id!: number;
  @Column({ name: 'po_id', type: 'integer' }) poId!: number;
  @Column({ name: 'product_id', type: 'integer' }) productId!: number;
  @Column({ type: 'integer' }) qty!: number;
  @Column({ name: 'received_qty', type: 'integer', default: 0 }) receivedQty!: number;
  @Column({ name: 'unit_cost', type: 'double precision' }) unitCost!: number;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' }) createdAt!: Date;
}

@Entity('grns')
export class Grn {
  @PrimaryGeneratedColumn('increment') id!: number;
  @Column({ type: 'varchar', nullable: true }) ref!: string | null;
  @Column({ name: 'po_id', type: 'integer' }) poId!: number;
  @Column({ name: 'supplier_id', type: 'integer', nullable: true }) supplierId!: number | null;
  @Column({ name: 'branch_id', type: 'integer', nullable: true }) branchId!: number | null;
  @Column({ name: 'received_at', type: 'timestamptz' }) receivedAt!: Date;
  @Column({ type: 'text', default: '' }) notes!: string;
  @Column({ name: 'received_by', type: 'integer', nullable: true }) receivedBy!: number | null;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' }) createdAt!: Date;
}

@Entity('grn_items')
export class GrnItem {
  @PrimaryGeneratedColumn('increment') id!: number;
  @Column({ name: 'grn_id', type: 'integer' }) grnId!: number;
  @Column({ name: 'po_item_id', type: 'integer' }) poItemId!: number;
  @Column({ name: 'product_id', type: 'integer' }) productId!: number;
  @Column({ name: 'qty_received', type: 'integer' }) qtyReceived!: number;
  @Column({ name: 'qty_damaged', type: 'integer', default: 0 }) qtyDamaged!: number;
  @Column({ name: 'unit_cost', type: 'double precision' }) unitCost!: number;
}

@Entity('inventory_movements')
export class InventoryMovement {
  @PrimaryGeneratedColumn('increment') id!: number;
  @Column({ name: 'product_id', type: 'integer' }) productId!: number;
  @Column({ type: 'integer' }) change!: number;
  @Column({ type: 'text' }) reason!: string;
  @Column({ type: 'text', nullable: true }) note!: string | null;
  @Column({ name: 'ref_type', type: 'text', nullable: true }) refType!: string | null;
  @Column({ name: 'ref_id', type: 'integer', nullable: true }) refId!: number | null;
  @Column({ name: 'balance_after', type: 'integer' }) balanceAfter!: number;
  @Column({ name: 'actor_id', type: 'integer', nullable: true }) actorId!: number | null;
  @Column({ name: 'balance_before', type: 'integer', nullable: true }) balanceBefore!: number | null;
  @Column({ name: 'reason_code', type: 'text', nullable: true }) reasonCode!: string | null;
  @Column({ name: 'branch_id', type: 'integer', nullable: true }) branchId!: number | null;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' }) createdAt!: Date;
}

@Entity('stock_reconciliations')
export class StockReconciliation {
  @PrimaryGeneratedColumn('increment') id!: number;
  @Column({ name: 'product_id', type: 'integer' }) productId!: number;
  @Column({ name: 'system_qty', type: 'integer' }) systemQty!: number;
  @Column({ name: 'counted_qty', type: 'integer' }) countedQty!: number;
  @Column({ name: 'diff_qty', type: 'integer' }) diffQty!: number;
  @Column({ type: 'text', default: 'open' }) status!: string;
  @Column({ name: 'reason_code', type: 'text' }) reasonCode!: string;
  @Column({ type: 'text', default: '' }) note!: string;
  @Column({ name: 'branch_id', type: 'integer', nullable: true }) branchId!: number | null;
  @Column({ name: 'created_by', type: 'integer', nullable: true }) createdBy!: number | null;
  @Column({ name: 'applied_by', type: 'integer', nullable: true }) appliedBy!: number | null;
  @Column({ name: 'applied_at', type: 'timestamptz', nullable: true }) appliedAt!: Date | null;
  @Column({ name: 'movement_id', type: 'integer', nullable: true }) movementId!: number | null;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' }) createdAt!: Date;
}

@Entity('cost_history')
export class CostHistory {
  @PrimaryGeneratedColumn('increment') id!: number;
  @Column({ name: 'product_id', type: 'integer' }) productId!: number;
  @Column({ name: 'source_type', type: 'text' }) sourceType!: string;
  @Column({ name: 'grn_id', type: 'integer', nullable: true }) grnId!: number | null;
  @Column({ name: 'supplier_id', type: 'integer', nullable: true }) supplierId!: number | null;
  @Column({ name: 'branch_id', type: 'integer', nullable: true }) branchId!: number | null;
  @Column({ name: 'qty_received', type: 'integer', nullable: true }) qtyReceived!: number | null;
  @Column({ name: 'unit_cost', type: 'double precision' }) unitCost!: number;
  @Column({ name: 'prev_cost', type: 'double precision', nullable: true }) prevCost!: number | null;
  @Column({ name: 'new_cost', type: 'double precision', nullable: true }) newCost!: number | null;
  @Column({ name: 'actor_id', type: 'integer', nullable: true }) actorId!: number | null;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' }) createdAt!: Date;
}

@Entity('branch_inventory')
export class BranchInventory {
  @Column({ name: 'branch_id', type: 'integer', primary: true }) branchId!: number;
  @Column({ name: 'product_id', type: 'integer', primary: true }) productId!: number;
  @Column({ type: 'integer', default: 0 }) quantity!: number;
  @Column({ type: 'double precision', default: 0 }) cost!: number;
  @Column({ name: 'low_stock_threshold', type: 'integer', default: 5 }) lowStockThreshold!: number;
  @Column({ name: 'reorder_qty', type: 'integer', default: 0 }) reorderQty!: number;
  @Column({ name: 'updated_at', type: 'timestamptz', nullable: true }) updatedAt!: Date | null;
}

@Entity('stock_transfers')
export class StockTransfer {
  @PrimaryGeneratedColumn('increment') id!: number;
  @Column({ type: 'varchar', nullable: true }) ref!: string | null;
  @Column({ name: 'source_branch_id', type: 'integer' }) sourceBranchId!: number;
  @Column({ name: 'dest_branch_id', type: 'integer' }) destBranchId!: number;
  @Column({ type: 'text', default: 'draft' }) status!: string;
  @Column({ type: 'text', default: '' }) notes!: string;
  @Column({ name: 'created_by', type: 'integer', nullable: true }) createdBy!: number | null;
  @Column({ name: 'approved_by', type: 'integer', nullable: true }) approvedBy!: number | null;
  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true }) approvedAt!: Date | null;
  @Column({ name: 'last_dispatched_by', type: 'integer', nullable: true }) lastDispatchedBy!: number | null;
  @Column({ name: 'last_dispatched_at', type: 'timestamptz', nullable: true }) lastDispatchedAt!: Date | null;
  @Column({ name: 'last_received_by', type: 'integer', nullable: true }) lastReceivedBy!: number | null;
  @Column({ name: 'last_received_at', type: 'timestamptz', nullable: true }) lastReceivedAt!: Date | null;
  @Column({ name: 'cancelled_by', type: 'integer', nullable: true }) cancelledBy!: number | null;
  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true }) cancelledAt!: Date | null;
  @Column({ name: 'cancel_reason', type: 'text', default: '' }) cancelReason!: string;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' }) createdAt!: Date;
  @Column({ name: 'updated_at', type: 'timestamptz', nullable: true }) updatedAt!: Date | null;
}

@Entity('stock_transfer_items')
export class StockTransferItem {
  @PrimaryGeneratedColumn('increment') id!: number;
  @Column({ name: 'transfer_id', type: 'integer' }) transferId!: number;
  @Column({ name: 'product_id', type: 'integer' }) productId!: number;
  @Column({ type: 'integer' }) qty!: number;
  @Column({ name: 'dispatched_qty', type: 'integer', default: 0 }) dispatchedQty!: number;
  @Column({ name: 'received_qty', type: 'integer', default: 0 }) receivedQty!: number;
  @Column({ name: 'unit_cost', type: 'double precision', nullable: true }) unitCost!: number | null;
}

@Entity('sales')
export class Sale {
  @PrimaryGeneratedColumn('increment') id!: number;
  @Column({ name: 'invoice_no', type: 'varchar' }) invoiceNo!: string;
  @Column({ type: 'double precision' }) subtotal!: number;
  @Column({ name: 'tax_total', type: 'double precision', default: 0 }) taxTotal!: number;
  @Column({ type: 'double precision', default: 0 }) discount!: number;
  @Column({ type: 'double precision' }) total!: number;
  @Column({ type: 'double precision' }) paid!: number;
  @Column({ name: 'change_amount', type: 'double precision', default: 0 }) changeAmount!: number;
  @Column({ name: 'payment_method', type: 'text', default: 'cash' }) paymentMethod!: string;
  @Column({ name: 'branch_id', type: 'integer', nullable: true }) branchId!: number | null;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' }) createdAt!: Date;
}

@Entity('sale_items')
export class SaleItem {
  @PrimaryGeneratedColumn('increment') id!: number;
  @Column({ name: 'sale_id', type: 'integer' }) saleId!: number;
  @Column({ name: 'product_id', type: 'integer' }) productId!: number;
  @Column({ name: 'product_name', type: 'text' }) productName!: string;
  @Column({ type: 'integer' }) quantity!: number;
  @Column({ name: 'unit_price', type: 'double precision' }) unitPrice!: number;
  @Column({ name: 'unit_cost', type: 'double precision', default: 0 }) unitCost!: number;
  @Column({ name: 'tax_rate', type: 'double precision', default: 0 }) taxRate!: number;
  @Column({ name: 'line_subtotal', type: 'double precision' }) lineSubtotal!: number;
  @Column({ name: 'line_tax', type: 'double precision' }) lineTax!: number;
  @Column({ name: 'line_total', type: 'double precision' }) lineTotal!: number;
}

@Entity('settings')
export class Setting {
  @Column({ type: 'text', primary: true }) key!: string;
  @Column({ type: 'text' }) value!: string;
}

@Entity('subscription_plans')
export class SubscriptionPlan {
  @PrimaryGeneratedColumn('increment') id!: number;
  @Column({ type: 'text' }) name!: string;
  @Column({ type: 'text' }) slug!: string;
  @Column({ type: 'text', default: '' }) description!: string;
  @Column({ name: 'price_monthly', type: 'double precision', default: 0 }) priceMonthly!: number;
  @Column({ name: 'price_yearly', type: 'double precision', default: 0 }) priceYearly!: number;
  @Column({ type: 'text', default: 'USD' }) currency!: string;
  @Column({ name: 'trial_days', type: 'integer', default: 0 }) trialDays!: number;
  @Column({ name: 'max_users', type: 'integer', default: 0 }) maxUsers!: number;
  @Column({ name: 'max_branches', type: 'integer', default: 0 }) maxBranches!: number;
  @Column({ name: 'max_products', type: 'integer', default: 0 }) maxProducts!: number;
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" }) features!: Record<string, boolean>;
  @Column({ name: 'is_active', type: 'boolean', default: true }) isActive!: boolean;
  @Column({ name: 'sort_order', type: 'integer', default: 0 }) sortOrder!: number;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' }) createdAt!: Date;
  @Column({ name: 'updated_at', type: 'timestamptz', nullable: true }) updatedAt!: Date | null;
}

@Entity('organization_subscriptions')
export class OrganizationSubscription {
  @PrimaryGeneratedColumn('increment') id!: number;
  @Column({ name: 'organization_id', type: 'integer' }) organizationId!: number;
  @Column({ name: 'plan_id', type: 'integer' }) planId!: number;
  @Column({ type: 'text', default: 'trialing' }) status!: string;
  @Column({ name: 'trial_starts_at', type: 'timestamptz', nullable: true }) trialStartsAt!: Date | null;
  @Column({ name: 'trial_ends_at', type: 'timestamptz', nullable: true }) trialEndsAt!: Date | null;
  @Column({ name: 'current_period_starts_at', type: 'timestamptz', nullable: true }) currentPeriodStartsAt!: Date | null;
  @Column({ name: 'current_period_ends_at', type: 'timestamptz', nullable: true }) currentPeriodEndsAt!: Date | null;
  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true }) cancelledAt!: Date | null;
  @Column({ name: 'cancel_reason', type: 'text', default: '' }) cancelReason!: string;
  @Column({ name: 'external_subscription_id', type: 'text', nullable: true }) externalSubscriptionId!: string | null;
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" }) metadata!: Record<string, unknown>;
  // Phase 33: License fields
  @Column({ name: 'license_code', type: 'varchar', nullable: true }) licenseCode!: string | null;
  @Column({ name: 'user_limit', type: 'integer', default: 0 }) userLimit!: number;
  @Column({ name: 'branch_limit', type: 'integer', default: 0 }) branchLimit!: number;
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" }) features!: Record<string, boolean>;
  @Column({ type: 'text', default: '' }) notes!: string;
  @Column({ name: 'created_by', type: 'integer', nullable: true }) createdBy!: number | null;
  @Column({ name: 'extended_at', type: 'timestamptz', nullable: true }) extendedAt!: Date | null;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' }) createdAt!: Date;
  @Column({ name: 'updated_at', type: 'timestamptz', nullable: true }) updatedAt!: Date | null;
}

@Entity('billing_events')
export class BillingEvent {
  @PrimaryGeneratedColumn('increment') id!: number;
  @Column({ name: 'organization_id', type: 'integer', nullable: true }) organizationId!: number | null;
  @Column({ name: 'subscription_id', type: 'integer', nullable: true }) subscriptionId!: number | null;
  @Column({ name: 'event_type', type: 'text' }) eventType!: string;
  @Column({ type: 'text', default: 'manual' }) provider!: string;
  @Column({ name: 'provider_event_id', type: 'text', nullable: true }) providerEventId!: string | null;
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" }) payload!: unknown;
  @Column({ type: 'text', default: 'pending' }) status!: string;
  @Column({ name: 'error_message', type: 'text', default: '' }) errorMessage!: string;
  @Column({ name: 'idempotency_key', type: 'text' }) idempotencyKey!: string;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' }) createdAt!: Date;
}

@Entity('billing_invoices')
export class BillingInvoice {
  @PrimaryGeneratedColumn('increment') id!: number;
  @Column({ name: 'organization_id', type: 'integer' }) organizationId!: number;
  @Column({ name: 'subscription_id', type: 'integer', nullable: true }) subscriptionId!: number | null;
  @Column({ name: 'invoice_number', type: 'text' }) invoiceNumber!: string;
  @Column({ type: 'double precision', default: 0 }) amount!: number;
  @Column({ type: 'text', default: 'USD' }) currency!: string;
  @Column({ type: 'text', default: 'draft' }) status!: string;
  @Column({ name: 'period_starts_at', type: 'timestamptz', nullable: true }) periodStartsAt!: Date | null;
  @Column({ name: 'period_ends_at', type: 'timestamptz', nullable: true }) periodEndsAt!: Date | null;
  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true }) paidAt!: Date | null;
  @Column({ name: 'external_invoice_id', type: 'text', nullable: true }) externalInvoiceId!: string | null;
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" }) metadata!: unknown;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' }) createdAt!: Date;
}

@Entity('license_history')
export class LicenseHistory {
  @PrimaryGeneratedColumn('increment') id!: number;
  @Column({ name: 'organization_id', type: 'integer' }) organizationId!: number;
  @Column({ name: 'subscription_id', type: 'integer', nullable: true }) subscriptionId!: number | null;
  @Column({ type: 'text' }) action!: string;
  @Column({ name: 'actor_id', type: 'integer', nullable: true }) actorId!: number | null;
  @Column({ name: 'license_code', type: 'text', nullable: true }) licenseCode!: string | null;
  @Column({ name: 'previous_value', type: 'jsonb', nullable: true }) previousValue!: Record<string, unknown> | null;
  @Column({ name: 'new_value', type: 'jsonb', nullable: true }) newValue!: Record<string, unknown> | null;
  @Column({ type: 'text', default: '' }) reason!: string;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' }) createdAt!: Date;
}

/** All entities, for TypeORM registration. */
export const entitiesArray = [
  User, RefreshToken, AuditLog, Branch, UserBranch, Category, Product, Supplier,
  PurchaseOrder, PurchaseOrderItem, Grn, GrnItem, InventoryMovement,
  StockReconciliation, CostHistory, BranchInventory, StockTransfer,
  StockTransferItem, Sale, SaleItem, Setting,
  SubscriptionPlan, OrganizationSubscription, BillingEvent, BillingInvoice,
  AiInsight, LicenseHistory,
  Organization, OrganizationMember,
];
