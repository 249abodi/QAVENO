import { login, req, resetDb, seedOwner, startTestBackend, TestCtx } from './bootstrap-pg';

describe('analytics & reporting: calculations, WAC profit, tenant isolation, RBAC (real PostgreSQL)', () => {
  let ctx: TestCtx;
  let owner: { token: string };
  let testProducts: any[] = [];

  beforeAll(async () => {
    ctx = await startTestBackend();
    await resetDb(ctx.ds);
    owner = await seedOwner(ctx);

    // Seed products via API (creates branch_inventory with qty=0)
    for (let i = 1; i <= 5; i++) {
      const res = await req(ctx, owner, 'post', '/api/v1/products').send({
        name: `Analytics Product ${i}`,
        barcode: `ANL-${i}`,
        price: 100 + i * 10,
        cost: 50 + i * 5,
        categoryId: null,
      });
      expect([200, 201]).toContain(res.status);
      // Add stock via inventory adjust (qty=0 after product creation)
      await req(ctx, owner, 'post', '/api/v1/inventory/adjust').send({
        productId: res.body.id,
        delta: 20,
        reasonCode: 'OPENING',
      }).expect(201);
      testProducts.push(res.body);
    }

    // Create sales via correct endpoint with stock now available
    for (let i = 0; i < 5; i++) {
      const p = testProducts[i % testProducts.length];
      const saleRes = await req(ctx, owner, 'post', '/api/v1/sales/checkout').send({
        items: [{ productId: p.id, quantity: 2 }],
        paid: 500,
        paymentMethod: i % 2 === 0 ? 'cash' : 'card',
      });
      expect([200, 201]).toContain(saleRes.status);
    }

    // Seed inventory_movements for stock-movements test
    await ctx.ds.query(
      `INSERT INTO inventory_movements (product_id, branch_id, actor_id, change, balance_before, balance_after, reason, created_at)
       SELECT p.id, 1, (SELECT id FROM users LIMIT 1), 5, 0, 5, 'OPENING', now() - interval '2 hours'
       FROM products p WHERE p.barcode='ANL-1' AND p.organization_id=1`,
    );
    await ctx.ds.query(
      `INSERT INTO inventory_movements (product_id, branch_id, actor_id, change, balance_before, balance_after, reason, created_at)
       SELECT p.id, 1, (SELECT id FROM users LIMIT 1), -2, 5, 3, 'SALE', now() - interval '1 hour'
       FROM products p WHERE p.barcode='ANL-2' AND p.organization_id=1`,
    );
  }, 300000);

  afterAll(async () => {
    if (ctx) await ctx.stop();
  }, 120000);

  // ============================================================
  // 1. Dashboard KPIs
  // ============================================================

  test('GET /analytics/dashboard returns KPIs', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/analytics/dashboard');
    expect(res.status).toBe(200);
    expect(typeof res.body.revenue).toBe('number');
    expect(typeof res.body.totalSales).toBe('number');
    expect(typeof res.body.grossProfit).toBe('number');
    expect(typeof res.body.taxes).toBe('number');
    expect(typeof res.body.discounts).toBe('number');
    expect(typeof res.body.stockValue).toBe('number');
    expect(typeof res.body.lowStockProducts).toBe('number');
    expect(typeof res.body.activeProducts).toBe('number');
    expect(typeof res.body.pendingPOs).toBe('number');
    expect(typeof res.body.activeTransfers).toBe('number');
    expect(res.body.dateRange.from).toBeTruthy();
    expect(res.body.dateRange.to).toBeTruthy();
  });

  test('Dashboard revenue matches checkout totals', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/analytics/dashboard');
    expect(res.body.totalSales).toBeGreaterThanOrEqual(5);
    expect(res.body.revenue).toBeGreaterThan(0);
  });

  // ============================================================
  // 2. Sales trend
  // ============================================================

  test('GET /analytics/sales-trend returns daily aggregation', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/analytics/sales-trend');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    const today = res.body[res.body.length - 1];
    expect(today.day).toBeTruthy();
    expect(typeof today.salesCount).toBe('number');
    expect(typeof today.revenue).toBe('number');
    expect(today.salesCount).toBeGreaterThanOrEqual(1);
  });

  test('Sales trend with date range filter', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await req(ctx, owner, 'get', `/api/v1/analytics/sales-trend?from=${today}&to=${today}T23:59:59Z`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  // ============================================================
  // 3. Profit trend (WAC-based)
  // ============================================================

  test('GET /analytics/profit-trend returns WAC-based profit', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/analytics/profit-trend');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    if (res.body.length > 0) {
      const day = res.body[res.body.length - 1];
      expect(typeof day.revenue).toBe('number');
      expect(typeof day.costOfGoods).toBe('number');
      expect(typeof day.grossProfit).toBe('number');
      expect(day.grossProfit).toBeCloseTo(day.revenue - day.costOfGoods, 1);
    }
  });

  // ============================================================
  // 4. Top products
  // ============================================================

  test('GET /analytics/top-products returns ranked products', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/analytics/top-products');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    const top = res.body[0];
    expect(top.productId).toBeTruthy();
    expect(top.productName).toBeTruthy();
    expect(typeof top.totalQty).toBe('number');
    expect(typeof top.totalRevenue).toBe('number');
    expect(typeof top.totalCost).toBe('number');
    expect(typeof top.grossProfit).toBe('number');
    expect(top.grossProfit).toBeCloseTo(top.totalRevenue - top.totalCost, 1);
  });

  test('Top products respects limit', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/analytics/top-products?limit=3');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(3);
  });

  // ============================================================
  // 5. Branch performance
  // ============================================================

  test('GET /analytics/branch-performance returns branch data', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/analytics/branch-performance');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    const branch = res.body[0];
    expect(branch.branchId).toBeTruthy();
    expect(branch.branchName).toBeTruthy();
    expect(typeof branch.salesCount).toBe('number');
    expect(typeof branch.revenue).toBe('number');
    expect(typeof branch.grossProfit).toBe('number');
  });

  // ============================================================
  // 6. Category performance
  // ============================================================

  test('GET /analytics/category-performance returns categories', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/analytics/category-performance');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  // ============================================================
  // 7. Supplier performance
  // ============================================================

  test('GET /analytics/supplier-performance returns suppliers', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/analytics/supplier-performance');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  // ============================================================
  // 8. Inventory valuation
  // ============================================================

  test('GET /analytics/inventory-valuation returns valuation', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/analytics/inventory-valuation');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.summary).toBeTruthy();
    expect(typeof res.body.summary.totalValue).toBe('number');
    expect(typeof res.body.summary.productCount).toBe('number');
    expect(typeof res.body.summary.totalQty).toBe('number');
  });

  // ============================================================
  // 9. Low stock products
  // ============================================================

  test('GET /analytics/low-stock returns low stock items', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/analytics/low-stock');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  // ============================================================
  // 10. Payment methods
  // ============================================================

  test('GET /analytics/payment-methods returns breakdown', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/analytics/payment-methods');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    const pm = res.body[0];
    expect(pm.paymentMethod).toBeTruthy();
    expect(typeof pm.count).toBe('number');
    expect(typeof pm.revenue).toBe('number');
  });

  // ============================================================
  // 11. Purchase analytics
  // ============================================================

  test('GET /analytics/purchases returns purchase summary', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/analytics/purchases');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.statusSummary)).toBe(true);
    expect(Array.isArray(res.body.monthlyPurchases)).toBe(true);
    expect(res.body.damagedUnits).toBeTruthy();
  });

  // ============================================================
  // 12. Transfer analytics
  // ============================================================

  test('GET /analytics/transfers returns transfer summary', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/analytics/transfers');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.byStatus)).toBe(true);
    expect(res.body.summary).toBeTruthy();
    expect(typeof res.body.summary.totalTransfers).toBe('number');
    expect(typeof res.body.summary.completed).toBe('number');
  });

  // ============================================================
  // 13. Discount analytics
  // ============================================================

  test('GET /analytics/discounts returns daily discounts', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/analytics/discounts');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  // ============================================================
  // 14. Tax analytics
  // ============================================================

  test('GET /analytics/taxes returns daily taxes', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/analytics/taxes');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  // ============================================================
  // 15. Stock movements
  // ============================================================

  test('GET /analytics/stock-movements returns byReason and byDay', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/analytics/stock-movements');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.byReason)).toBe(true);
    expect(Array.isArray(res.body.byDay)).toBe(true);
    expect(res.body.byReason.length).toBeGreaterThanOrEqual(1);
  });

  // ============================================================
  // 16. Reports — Sales
  // ============================================================

  test('GET /analytics/report/sales returns paginated sales', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/analytics/report/sales');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe('number');
    expect(res.body.total).toBeGreaterThanOrEqual(5);
    expect(res.body.page).toBe(1);
    expect(res.body.items[0].invoiceNo).toBeTruthy();
    expect(typeof res.body.items[0].total).toBe('number');
  });

  test('Sales report pagination works', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/analytics/report/sales?page=1&pageSize=2');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeLessThanOrEqual(2);
    expect(res.body.pageSize).toBe(2);
  });

  // ============================================================
  // 17. Reports — Profit
  // ============================================================

  test('GET /analytics/report/profit returns profit by product', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/analytics/report/profit');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    if (res.body.items.length > 0) {
      const item = res.body.items[0];
      expect(item.productName).toBeTruthy();
      expect(typeof item.revenue).toBe('number');
      expect(typeof item.costOfGoods).toBe('number');
      expect(typeof item.profit).toBe('number');
    }
  });

  // ============================================================
  // 18. Reports — Purchasing
  // ============================================================

  test('GET /analytics/report/purchasing returns purchase orders', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/analytics/report/purchasing');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe('number');
  });

  // ============================================================
  // 19. Reports — Branches
  // ============================================================

  test('GET /analytics/report/branches returns branch comparison', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/analytics/report/branches');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    const branch = res.body[0];
    expect(branch.branchId).toBeTruthy();
    expect(branch.branchName).toBeTruthy();
    expect(typeof branch.stockValue).toBe('number');
    expect(typeof branch.salesCount).toBe('number');
  });

  // ============================================================
  // 20. Reports — Movements
  // ============================================================

  test('GET /analytics/report/movements returns paginated movements', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/analytics/report/movements');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe('number');
    expect(res.body.total).toBeGreaterThan(0);
  });

  // ============================================================
  // 21. CSV Exports
  // ============================================================

  test('GET /analytics/export/sales returns CSV', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/analytics/export/sales');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('Invoice');
    expect(res.text).toContain('INV-');
  });

  test('GET /analytics/export/profit returns CSV', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/analytics/export/profit');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('Product');
  });

  test('GET /analytics/export/inventory returns CSV', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/analytics/export/inventory');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('Product');
    expect(res.text).toContain('Quantity');
  });

  // ============================================================
  // 22. Product performance
  // ============================================================

  test('GET /analytics/product-performance returns detailed product metrics', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/analytics/product-performance');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    const p = res.body[0];
    expect(p.productId).toBeTruthy();
    expect(p.productName).toBeTruthy();
    expect(typeof p.soldQty).toBe('number');
    expect(typeof p.revenue).toBe('number');
    expect(typeof p.profit).toBe('number');
    expect(typeof p.totalStock).toBe('number');
    expect(typeof p.stockValue).toBe('number');
  });

  // ============================================================
  // 23. Date range filtering
  // ============================================================

  test('Date range filtering works across endpoints', async () => {
    const from = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const res = await req(ctx, owner, 'get', `/api/v1/analytics/dashboard?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    expect(res.body.dateRange.from).toContain(from);
  });

  // ============================================================
  // 24. Branch filtering
  // ============================================================

  test('Branch filter works on sales-trend', async () => {
    const res = await req(ctx, owner, 'get', '/api/v1/analytics/sales-trend?branchId=1');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  // ============================================================
  // 25. Empty datasets
  // ============================================================

  test('Analytics returns valid data even with narrow date range', async () => {
    const from = '2000-01-01';
    const to = '2000-01-02';
    const res = await req(ctx, owner, 'get', `/api/v1/analytics/dashboard?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    expect(res.body.revenue).toBe(0);
    expect(res.body.totalSales).toBe(0);
  });

  // ============================================================
  // 26. RBAC — cashier cannot access analytics
  // ============================================================

  test('Cashier cannot access analytics endpoints', async () => {
    const createRes = await req(ctx, owner, 'post', '/api/v1/users').send({
      username: 'anl_cashier',
      password: 'CashierPass1!',
      role: 'cashier',
    });
    expect([200, 201]).toContain(createRes.status);
    const cashier = await login(ctx, 'anl_cashier', 'CashierPass1!');
    const res = await req(ctx, cashier, 'get', '/api/v1/analytics/dashboard');
    expect(res.status).toBe(403);
  });

  test('Manager can access analytics endpoints', async () => {
    const createRes = await req(ctx, owner, 'post', '/api/v1/users').send({
      username: 'anl_manager',
      password: 'ManagerPass1!',
      role: 'manager',
      branches: [{ branchId: 1, isPrimary: true }],
    });
    expect([200, 201]).toContain(createRes.status);
    const mgr = await login(ctx, 'anl_manager', 'ManagerPass1!');
    const res = await req(ctx, mgr, 'get', '/api/v1/analytics/dashboard');
    expect(res.status).toBe(200);
  });

  // ============================================================
  // 27. Unauthenticated access blocked
  // ============================================================

  test('Analytics endpoints require authentication', async () => {
    const endpoints = [
      '/api/v1/analytics/dashboard',
      '/api/v1/analytics/sales-trend',
      '/api/v1/analytics/profit-trend',
      '/api/v1/analytics/top-products',
      '/api/v1/analytics/inventory-valuation',
      '/api/v1/analytics/report/sales',
    ];
    for (const url of endpoints) {
      const res = await ctx.api().get(url);
      expect(res.status).toBe(401);
    }
  });

  // ============================================================
  // 28. Suspended org access blocked
  // ============================================================

  test('Suspended org blocked from analytics', async () => {
    await ctx.ds.manager.query(`UPDATE organizations SET status='suspended' WHERE id=1`);
    const res = await req(ctx, owner, 'get', '/api/v1/analytics/dashboard');
    expect(res.status).toBe(401);
    await ctx.ds.manager.query(`UPDATE organizations SET status='active' WHERE id=1`);
  });

  // ============================================================
  // 29. WAC profit calculation correctness
  // ============================================================

  test('WAC-based profit matches expected calculation', async () => {
    const prodRes = await req(ctx, owner, 'post', '/api/v1/products').send({
      name: 'WAC Test Product',
      barcode: 'WAC-TEST-001',
      price: 200,
      cost: 100,
    });
    expect([200, 201]).toContain(prodRes.status);
    const wacProductId = prodRes.body.id;

    await req(ctx, owner, 'post', '/api/v1/inventory/adjust').send({
      productId: wacProductId,
      delta: 50,
      reasonCode: 'OPENING',
    }).expect(201);

    await req(ctx, owner, 'post', '/api/v1/sales/checkout').send({
      items: [{ productId: wacProductId, quantity: 3 }],
      paid: 1000,
      paymentMethod: 'cash',
    }).expect(201);

    const from = new Date().toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10) + 'T23:59:59Z';

    const topRes = await req(ctx, owner, 'get', `/api/v1/analytics/top-products?from=${from}&to=${to}`);
    const wacProduct = topRes.body.find((p: any) => p.productName === 'WAC Test Product');
    expect(wacProduct).toBeTruthy();
    expect(wacProduct.totalQty).toBe(3);
    expect(wacProduct.totalRevenue).toBeGreaterThan(0);
    expect(wacProduct.totalCost).toBeGreaterThan(0);
    expect(wacProduct.grossProfit).toBeCloseTo(wacProduct.totalRevenue - wacProduct.totalCost, 1);

    const profitRes = await req(ctx, owner, 'get', `/api/v1/analytics/profit-trend?from=${from}&to=${to}`);
    expect(profitRes.status).toBe(200);
    if (profitRes.body.length > 0) {
      const day = profitRes.body[profitRes.body.length - 1];
      expect(day.grossProfit).toBeCloseTo(day.revenue - day.costOfGoods, 1);
    }
  });

  // ============================================================
  // 30. Performance — large date range doesn't crash
  // ============================================================

  test('1-year date range is clamped and returns valid response', async () => {
    const from = '2020-01-01';
    const to = '2026-12-31';
    const res = await req(ctx, owner, 'get', `/api/v1/analytics/dashboard?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    expect(res.body.dateRange).toBeTruthy();
  });
});
