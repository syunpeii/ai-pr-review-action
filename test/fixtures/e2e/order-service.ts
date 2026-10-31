export interface CatalogItem {
  sku: string;
  name: string;
  unitPrice: number;
  taxExempt?: boolean;
}

export interface OrderLine {
  sku: string;
  quantity: number;
}

export interface OrderInput {
  orderId: string;
  customerId: string;
  lines: OrderLine[];
}

export interface OrderSummary {
  orderId: string;
  subtotal: number;
  tax: number;
  total: number;
}

export interface AuditLogger {
  record(event: { orderId: string; customerId: string; total: number }): Promise<void>;
}

const TAX_RATE = 0.1;

export function calculateOrderSummary(
  order: OrderInput,
  catalog: CatalogItem[],
): OrderSummary {
  const catalogBySku = new Map(catalog.map((item) => [item.sku, item]));

  let subtotal = 0;
  let taxableAmount = 0;

  for (const line of order.lines) {
    if (line.quantity <= 0) {
      throw new Error(`Invalid quantity for SKU: ${line.sku}`);
    }
    const item = catalogBySku.get(line.sku);
    if (!item) {
      throw new Error(`Unknown SKU: ${line.sku}`);
    }

    const lineAmount = item.unitPrice * line.quantity;
    subtotal += lineAmount;
    if (!item.taxExempt) {
      taxableAmount += lineAmount;
    }
  }

  const tax = Math.floor(taxableAmount * TAX_RATE);
  return {
    orderId: order.orderId,
    subtotal,
    tax,
    total: subtotal + tax,
  };
}

export async function finalizeOrder(
  order: OrderInput,
  catalog: CatalogItem[],
  auditLogger: AuditLogger,
): Promise<OrderSummary> {
  const summary = calculateOrderSummary(order, catalog);
  await auditLogger.record({
    orderId: order.orderId,
    customerId: order.customerId,
    total: summary.total,
  });
  return summary;
}
