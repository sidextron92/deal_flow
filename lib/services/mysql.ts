import { RowDataPacket } from "mysql2";
import { CartItemRaw } from "@/lib/types";
import { getPool } from "@/lib/db";

const SELLER_ID = process.env.SELLER_ID || "1490492529";

export async function fetchCartFromMySQL(phone: string): Promise<CartItemRaw[]> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `
WITH cart_items AS (
  SELECT 
    ti.userID                        AS userid,
    ti.sellerID                      AS sellerid,
    sma.fmWarehouseId                AS fmWarehouseid,
    ti.productID                     AS productId,
    ti.variantID                     AS variantid,
    ti.sizeID                        AS sizeid,
    ti.setCount                      AS setCount,
    ti.setSize                       AS lotSize,
    p.mrp                            AS MRP,
    p.transferPrice                  AS purchasePriceWithoutTax,
    0                                AS retailerMargin,
    p.productName                    AS ProductName,
    c.colorName                      AS colorname,
    sm.sizeText                      AS sizetext,
    v.defImage                       AS imageurl,
    vss.quantity                     AS CurrentInventory,
    ad.zipcode                       AS pincode
  FROM truck_items ti
  INNER JOIN address_details ad ON ad.userID = ti.userID AND ad.isSelected = 1
  INNER JOIN user_master um     ON um.userid = ti.userid
  INNER JOIN variant_size_stock vss
          ON vss.variantID = ti.variantID
         AND vss.sizeID    = ti.sizeID
         AND vss.sellerID  = ti.sellerID
  INNER JOIN variants v         ON v.variantID = ti.variantID
  INNER JOIN products p         ON p.productid = ti.productID
  INNER JOIN colors c           ON c.uniqueId = ti.colorID
  INNER JOIN size_master sm     ON sm.sizeID = ti.sizeID
  INNER JOIN seller_master sma  ON sma.userid = ti.sellerID
  WHERE ti.status = 0
    AND ti.sellerid = ?
    AND um.companyPhone = ?
    AND ti.orderType = 'OnStock'
    AND vss.isVisible = 1
  GROUP BY ti.sellerID, ti.variantID, ti.sizeID
),

last_order AS (
  SELECT
    od.variantID,
    od.sizeID,
    o.sellerID,
    MIN(DATEDIFF(CURDATE(), o.created_at)) AS lastOrderAgo
  FROM order_details od
  INNER JOIN orders o ON o.orderID = od.orderID
  INNER JOIN cart_items ci
          ON ci.variantId = od.variantID
         AND ci.sizeId    = od.sizeID
         AND ci.sellerID  = o.sellerID
         AND o.delAddressId = 1
         AND od.remainingSetCount > 0
         AND o.createdOn > UNIX_TIMESTAMP(DATE_ADD(CURDATE(), INTERVAL - 30 DAY))
         AND o.sellerID = ?
  GROUP BY od.variantID, od.sizeID, o.sellerID
)

SELECT
  ci.userid,
  ci.sellerid,
  ci.fmWarehouseid,
  ci.productId,
  ci.variantid,
  ci.sizeid,
  ci.setCount,
  ci.purchasePriceWithoutTax,
  ci.MRP,
  ci.retailerMargin,
  ci.lotSize,
  ci.ProductName,
  ci.colorname,
  ci.sizetext,
  ci.imageurl,
  NULL                              AS SubCategory,
  NULL                              AS GroupName,
  NULL                              AS MainCategory,
  NULL                              AS Brand,
  NULL                              AS BrandType,
  COALESCE(lo.lastOrderAgo, 30)    AS DaysFromLastOrder,
  MAX(DATEDIFF(CURRENT_DATE, FROM_UNIXTIME(rmlla.startEventDate))) AS Ageing,
  ci.CurrentInventory,
  ci.pincode
FROM rm_lot_level_attribution rmlla
INNER JOIN cart_items ci
        ON rmlla.variantID  = ci.variantID
       AND rmlla.sizeID     = ci.sizeID
       AND rmlla.warehouseid = ci.fmWarehouseid
LEFT JOIN last_order lo
        ON rmlla.variantID = lo.variantID
       AND rmlla.sizeID    = lo.sizeID
WHERE rmlla.activeStatus = 1
  AND rmlla.isRemoved   = 0
  AND rmlla.soldDate    = 0
  AND rmlla.lotId       > 0
GROUP BY rmlla.variantId, rmlla.sizeId, rmlla.warehouseid;
    `,
    [SELLER_ID, phone, SELLER_ID]
  );

  console.log("[mysql] query returned rows:", rows.length, "rows");
  if (rows.length > 0) {
    console.log("[mysql] first row keys:", Object.keys(rows[0]));
  }
  return (rows as unknown as CartItemRaw[]) ?? [];
}
