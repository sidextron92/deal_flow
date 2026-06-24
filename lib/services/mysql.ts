import { RowDataPacket } from "mysql2";
import { CartItemRaw } from "@/lib/types";
import { getPool } from "@/lib/db";

const SELLER_ID = process.env.SELLER_ID || "1490492529";

export async function fetchCartFromMySQL(phone: string): Promise<CartItemRaw[]> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `
  SELECT
    ad.zipcode                       AS pincode,
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
    COALESCE(psds.eligibleDiscount,0) AS eligibleDiscount
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
  LEFT JOIN pre_shelfout_discount_skus psds
          ON psds.variantId = ti.variantID
         AND psds.sizeId = ti.sizeID
         AND psds.warehouseId = sma.fmWarehouseId
         AND psds.status = 1
         AND (psds.endDate IS NULL OR psds.endDate > CURDATE())
  WHERE ti.status = 0
    AND ti.sellerid = ?
    AND um.companyPhone = ?
    AND ti.orderType = 'OnStock'
    AND vss.isVisible = 1
    AND vss.quantity > 0
  GROUP BY ti.sellerID, ti.variantID, ti.sizeID;
    `,
    [SELLER_ID, phone]
  );

  console.log("[mysql] query returned rows:", rows.length, "rows");
  if (rows.length > 0) {
    console.log("[mysql] first row keys:", Object.keys(rows[0]));
  }
  return (rows as unknown as CartItemRaw[]) ?? [];
}
