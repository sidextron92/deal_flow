import { RowDataPacket } from "mysql2";
import { CartExclusions, CartItemRaw } from "@/lib/types";
import { getPool } from "@/lib/db";

// Resolve the trader's seller from their fosId via the canonical org mapping:
//   fosId -> fos_users.dsId -> seller_master(fmWarehouseId = dsId,
//                                            sellerType = 'BRAND_AGGREGATORS').userID
// A DS's other sellers are PRODUCTION_FACTORIES, so the BRAND_AGGREGATORS filter
// makes this unambiguous (exactly one per DS); >1 is flagged as a misconfig.
// Returns the sellerId as a string, or null if the fosId / DS / seller isn't found.
export async function resolveSellerIdFromFos(
  fosId: string
): Promise<string | null> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `
  SELECT sm.userID AS sellerId
  FROM fos_users fu
  INNER JOIN seller_master sm
          ON sm.fmWarehouseId = fu.dsId
         AND sm.sellerType = 'BRAND_AGGREGATORS'
  WHERE fu.fosId = ?
  LIMIT 5;
    `,
    [fosId]
  );
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    console.warn(
      `[seller-resolve] fosId ${fosId} maps to ${rows.length} BRAND_AGGREGATORS sellers (DS misconfig?); using ${rows[0].sellerId}`
    );
  }
  return rows[0].sellerId != null ? String(rows[0].sellerId) : null;
}

// The `sellerId` below is resolved from the trader's fosId (resolveSellerIdFromFos)
// — NOT a hardcoded constant; a fixed seller returns an empty cart for traders
// whose stock lives under a different seller.
export async function fetchCartFromMySQL(
  phone: string,
  sellerId: string
): Promise<CartItemRaw[]> {
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
    [sellerId, phone]
  );

  console.log("[mysql] query returned rows:", rows.length, "rows");
  if (rows.length > 0) {
    console.log("[mysql] first row keys:", Object.keys(rows[0]));
  }
  return (rows as unknown as CartItemRaw[]) ?? [];
}

// Counts the account's active (status=0) cart lines under this seller that the
// deal calculator filters out, so the UI can explain an empty/partial cart:
//   - outOfStock: OnStock items whose seller stock is <=0 / not visible / absent
//   - preOrder:   non-OnStock lines (the calculator only handles OnStock deals)
// Distinct by variant+size to mirror the cart query's GROUP BY.
export async function fetchCartExclusions(
  phone: string,
  sellerId: string
): Promise<CartExclusions> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `
  SELECT
    COUNT(DISTINCT CASE
      WHEN ti.orderType = 'OnStock'
       AND (vss.quantity IS NULL OR vss.quantity <= 0 OR vss.isVisible <> 1)
      THEN CONCAT(ti.variantID, '-', ti.sizeID) END) AS outOfStock,
    COUNT(DISTINCT CASE
      WHEN ti.orderType <> 'OnStock'
      THEN CONCAT(ti.variantID, '-', ti.sizeID) END) AS preOrder
  FROM truck_items ti
  INNER JOIN user_master um ON um.userid = ti.userid
  LEFT JOIN variant_size_stock vss
          ON vss.variantID = ti.variantID
         AND vss.sizeID    = ti.sizeID
         AND vss.sellerID  = ti.sellerID
  WHERE ti.status = 0
    AND ti.sellerid = ?
    AND um.companyPhone = ?;
    `,
    [sellerId, phone]
  );
  const row = rows[0] ?? {};
  return {
    outOfStock: Number(row.outOfStock ?? 0),
    preOrder: Number(row.preOrder ?? 0),
  };
}

// Whether ANY retailer is registered with this phone (independent of seller).
// Used only when a cart comes back empty, to tell "no such retailer" apart from
// "known retailer, but no cart under this trader's seller".
export async function retailerExists(phone: string): Promise<boolean> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT 1 FROM user_master WHERE companyPhone = ? LIMIT 1`,
    [phone]
  );
  return rows.length > 0;
}
