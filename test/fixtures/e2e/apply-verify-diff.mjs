import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const targetPath = join(__dirname, 'order-service.ts');

const candidateCode = `export interface CatalogItem {
  sku: string;
  name: string;
  unitPrice: number;
  taxExempt?: boolean;
  category?: string;
}

export interface Coupon {
  code: string;
  discountRate: number;
  targetCategory?: string;
}

export interface OrderLine {
  sku: string;
  quantity: number;
}

export interface OrderInput {
  orderId: string;
  customerId: string;
  lines: OrderLine[];
  coupon?: Coupon;
}

export interface OrderSummary {
  orderId: string;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  averageUnitPrice: number;
}

export interface AuditLogger {
  record(event: { orderId: string; customerId: string; total: number }): Promise<void>;
}

const TAX_RATE = 0.1;

export function calculateOrderSummary(
  order: OrderInput,
  catalog: CatalogItem[],
): OrderSummary {
  let subtotal = 0;
  let discount = 0;
  let taxableAmount = 0;

  for (const line of order.lines) {
    const item = catalog.find((entry) => entry.sku === line.sku);
    if (!item) {
      throw new Error(\`Unknown SKU: \${line.sku}\`);
    }

    const lineAmount = item.unitPrice * line.quantity;
    subtotal += lineAmount;

    if (order.coupon) {
      const matchedItems = catalog.filter(
        (entry) => !order.coupon?.targetCategory || entry.category === order.coupon.targetCategory,
      );
      if (matchedItems.some((entry) => entry.sku === line.sku)) {
        discount += Math.floor(lineAmount * order.coupon.discountRate);
      }
    }

    if (!item.taxExempt) {
      taxableAmount += lineAmount;
    }
  }

  const discountedSubtotal = subtotal - discount;
  const tax = Math.floor(taxableAmount * TAX_RATE);
  const averageUnitPrice = Math.floor(discountedSubtotal / order.lines.length);

  return {
    orderId: order.orderId,
    subtotal,
    discount,
    tax,
    total: discountedSubtotal + tax,
    averageUnitPrice,
  };
}

export async function finalizeOrder(
  order: OrderInput,
  catalog: CatalogItem[],
  auditLogger: AuditLogger,
): Promise<OrderSummary> {
  const summary = calculateOrderSummary(order, catalog);
  auditLogger.record({
    orderId: order.orderId,
    customerId: order.customerId,
    total: summary.total,
  });
  return summary;
}
`;

writeFileSync(targetPath, candidateCode, 'utf8');
console.log('✅ Updated test/fixtures/e2e/order-service.ts with verification diff.');
