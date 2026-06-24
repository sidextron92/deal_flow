import { RowDataPacket } from "mysql2";
import { getPool } from "@/lib/db";
import { DiscountEligibleSku, DiscountEligibleSkuRaw } from "@/lib/types";
import { fetchPricesForItems } from "./price-api";

const DISCOUNT_ELIGIBLE_WAREHOUSE_ID = 31;

export async function fetchDiscountEligibleSkus(
  destinationPincode: string
): Promise<DiscountEligibleSku[]> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `
SELECT
    psds.warehouseId                  AS warehouseid,
    p.productID                       AS productId,
    psds.variantID                    AS variantid,
    psds.sizeID                       AS sizeid,
    p.mrp                             AS MRP,
    psds.tpWithoutTax                 AS purchasePriceWithoutTax,
    0                                 AS retailerMargin,
    p.productName                     AS ProductName,
    c.colorName                       AS colorname,
    sm.sizeText                       AS sizetext,
    v.defImage                        AS imageurl,
    vss.quantity                      AS CurrentInventory,
    COALESCE(psds.eligibleDiscount,0) AS eligibleDiscount,
    psds.performanceData,
    cm.groupName                      AS categoryGroupName,
    cmm.name                          AS mainCategoryName
 FROM pre_shelfout_discount_skus psds
  INNER JOIN variant_size_stock vss ON vss.variantID = psds.variantId AND vss.sizeID = psds.sizeId
  INNER JOIN seller_master sma ON sma.userid = vss.sellerID AND sma.fmWarehouseId = psds.warehouseId
  INNER JOIN variants v ON v.variantID = psds.variantID
  INNER JOIN colors c ON c.uniqueId = v.colorID
  INNER JOIN size_master sm ON sm.sizeID = psds.sizeID
  INNER JOIN products p ON p.productid = v.productID
  INNER JOIN category_master cm ON cm.categoryid = p.subCategoryId
  INNER JOIN category_master cmm ON cmm.categoryid = cm.parentid
  WHERE psds.warehouseId = ?
    AND vss.isVisible = 1
    AND vss.quantity > 0
    AND psds.status = 1
    AND (psds.endDate IS NULL OR psds.endDate > CURDATE())
ORDER BY psds.warehouseId, psds.variantId;
    `,
    [DISCOUNT_ELIGIBLE_WAREHOUSE_ID]
  );

  const skus = rows as unknown as DiscountEligibleSkuRaw[];
  const prices = await fetchPricesForItems(
    skus.map((sku) => ({
      variantid: sku.variantid,
      sizeid: sku.sizeid,
      purchasePriceWithoutTax: sku.purchasePriceWithoutTax,
      MRP: sku.MRP,
    })),
    destinationPincode
  );

  return skus.map((sku, index) => {
    const price = prices[index] ?? {
      variantid: sku.variantid,
      sizeid: sku.sizeid,
      landingPriceBeforeTax: sku.purchasePriceWithoutTax,
      landingPrice: sku.MRP > 0 ? sku.MRP : sku.purchasePriceWithoutTax,
    };
    const retailMarginPct =
      sku.MRP > 0 ? ((sku.MRP - price.landingPrice) / sku.MRP) * 100 : null;

    return {
      ...sku,
      ...price,
      retailMarginPct,
    };
  });
}
