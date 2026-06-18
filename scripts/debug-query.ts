/* eslint-disable @typescript-eslint/no-explicit-any */
import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../.env.local") });

if (!process.env.DB_HOST) {
  console.error("❌ .env.local not loaded. DB_HOST is undefined.");
  process.exit(1);
}

import { getPool } from "../lib/db";

const SELLER_ID = process.env.SELLER_ID || "1490492473";
const PHONE = process.argv[2] || "8957168669";

async function debug() {
  const pool = getPool();
  console.log("✅ Env loaded");
  console.log("Host:", process.env.DB_HOST);
  console.log("Phone:", PHONE);
  console.log("Seller:", SELLER_ID);

  // Step 1: Does user exist?
  const [user] = await pool.query(
    `SELECT userid, companyPhone FROM user_master WHERE companyPhone = ? LIMIT 1`,
    [PHONE]
  );
  console.log("\n1. User lookup:", user.length > 0 ? user[0] : "NOT FOUND");

  if (user.length === 0) {
    console.log("\n❌ No user found with companyPhone =", PHONE);
    console.log("Checking if user_master has any phone-like columns...");
    const [cols] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_NAME = 'user_master' AND COLUMN_NAME LIKE '%phone%' OR COLUMN_NAME LIKE '%mobile%' OR COLUMN_NAME LIKE '%contact%'`
    );
    console.log("Possible columns:", cols);
    process.exit(0);
  }

  const userId = user[0].userid;
  console.log("User ID:", userId);

  // Step 2: Check truck_items
  const [truck] = await pool.query(
    `SELECT COUNT(*) as cnt FROM truck_items 
     WHERE sellerid = ? AND userid = ? AND status = 0 AND orderType = 'OnStock'`,
    [SELLER_ID, userId]
  );
  console.log("\n2. Truck items count:", truck[0]);

  // Step 3: Check variant_size_stock join
  const [vss] = await pool.query(
    `SELECT COUNT(*) as cnt FROM truck_items ti
     INNER JOIN variant_size_stock vss ON vss.variantID = ti.variantID AND vss.sizeID = ti.sizeID AND vss.sellerID = ti.sellerID
     WHERE ti.sellerid = ? AND ti.userid = ? AND ti.status = 0 AND ti.orderType = 'OnStock' AND vss.isVisible = 1`,
    [SELLER_ID, userId]
  );
  console.log("3. After vss join:", vss[0]);

  // Step 4: Check address_details join
  const [addr] = await pool.query(
    `SELECT COUNT(*) as cnt FROM truck_items ti
     INNER JOIN address_details ad ON ad.userID = ti.userID AND ad.isSelected = 1
     INNER JOIN variant_size_stock vss ON vss.variantID = ti.variantID AND vss.sizeID = ti.sizeID AND vss.sellerID = ti.sellerID
     WHERE ti.sellerid = ? AND ti.userid = ? AND ti.status = 0 AND ti.orderType = 'OnStock' AND vss.isVisible = 1`,
    [SELLER_ID, userId]
  );
  console.log("4. After address join:", addr[0]);

  // Step 5: All joins
  const [full] = await pool.query(
    `SELECT COUNT(*) as cnt FROM truck_items ti
     INNER JOIN address_details ad ON ad.userID = ti.userID AND ad.isSelected = 1
     INNER JOIN user_master um ON um.userid = ti.userid
     INNER JOIN variant_size_stock vss ON vss.variantID = ti.variantID AND vss.sizeID = ti.sizeID AND vss.sellerID = ti.sellerID
     INNER JOIN variants v ON v.variantID = ti.variantID
     INNER JOIN products p ON p.productid = ti.productID
     INNER JOIN colors c ON c.uniqueId = ti.colorID
     INNER JOIN size_master sm ON sm.sizeID = ti.sizeID
     INNER JOIN seller_master sma ON sma.userid = ti.sellerID
     WHERE ti.status = 0 AND ti.sellerid = ? AND ti.userid = ? AND ti.orderType = 'OnStock' AND vss.isVisible = 1`,
    [SELLER_ID, userId]
  );
  console.log("5. All joins (truck_items level):", full[0]);

  // Step 6: CTE count
  const [rows] = await pool.query(
    `
WITH cart_items AS (
  SELECT ti.userID, ti.sellerID, sma.fmWarehouseId, ti.productID, ti.variantID, ti.sizeID,
    ti.setCount, ti.setSize, p.mrp, p.transferPrice, p.productName, c.colorName, sm.sizeText,
    v.defImage, vss.quantity, ad.zipcode
  FROM truck_items ti
  INNER JOIN address_details ad ON ad.userID = ti.userID AND ad.isSelected = 1
  INNER JOIN user_master um ON um.userid = ti.userid
  INNER JOIN variant_size_stock vss ON vss.variantID = ti.variantID AND vss.sizeID = ti.sizeID AND vss.sellerID = ti.sellerID
  INNER JOIN variants v ON v.variantID = ti.variantID
  INNER JOIN products p ON p.productid = ti.productID
  INNER JOIN colors c ON c.uniqueId = ti.colorID
  INNER JOIN size_master sm ON sm.sizeID = ti.sizeID
  INNER JOIN seller_master sma ON sma.userid = ti.sellerID
  WHERE ti.status = 0 AND ti.sellerid = ? AND um.companyPhone = ? AND ti.orderType = 'OnStock' AND vss.isVisible = 1
  GROUP BY ti.sellerID, ti.variantID, ti.sizeID
)
SELECT COUNT(*) as cnt FROM cart_items
    `,
    [SELLER_ID, PHONE]
  );
  console.log("\n6. CTE cart_items count:", rows[0]);

  // Step 7: rm_lot_level_attribution
  const [rmla] = await pool.query(
    `SELECT COUNT(*) as cnt FROM rm_lot_level_attribution rmlla
     INNER JOIN (
       SELECT ti.variantID, ti.sizeID, sma.fmWarehouseId
       FROM truck_items ti
       INNER JOIN seller_master sma ON sma.userid = ti.sellerID
       WHERE ti.sellerid = ? AND ti.userid = ? AND ti.status = 0 AND ti.orderType = 'OnStock'
       GROUP BY ti.variantID, ti.sizeID, sma.fmWarehouseId
     ) ci ON rmlla.variantID = ci.variantID AND rmlla.sizeID = ci.sizeID AND rmlla.warehouseid = ci.fmWarehouseId
     WHERE rmlla.activeStatus = 1 AND rmlla.isRemoved = 0 AND rmlla.soldDate = 0 AND rmlla.lotId > 0`,
    [SELLER_ID, userId]
  );
  console.log("\n7. rm_lot_level_attribution matching:", rmla[0]);

  // Step 8: Full query
  const [final] = await pool.query(
    `
WITH cart_items AS (
  SELECT ti.userID, ti.sellerID, sma.fmWarehouseId, ti.productID, ti.variantID, ti.sizeID,
    ti.setCount, ti.setSize, p.mrp, p.transferPrice, p.productName, c.colorName, sm.sizeText,
    v.defImage, vss.quantity, ad.zipcode
  FROM truck_items ti
  INNER JOIN address_details ad ON ad.userID = ti.userID AND ad.isSelected = 1
  INNER JOIN user_master um ON um.userid = ti.userid
  INNER JOIN variant_size_stock vss ON vss.variantID = ti.variantID AND vss.sizeID = ti.sizeID AND vss.sellerID = ti.sellerID
  INNER JOIN variants v ON v.variantID = ti.variantID
  INNER JOIN products p ON p.productid = ti.productID
  INNER JOIN colors c ON c.uniqueId = ti.colorID
  INNER JOIN size_master sm ON sm.sizeID = ti.sizeID
  INNER JOIN seller_master sma ON sma.userid = ti.sellerID
  WHERE ti.status = 0 AND ti.sellerid = ? AND um.companyPhone = ? AND ti.orderType = 'OnStock' AND vss.isVisible = 1
  GROUP BY ti.sellerID, ti.variantID, ti.sizeID
),
last_order AS (
  SELECT od.variantID, od.sizeID, o.sellerID, MIN(DATEDIFF(CURDATE(), o.created_at)) as lastOrderAgo
  FROM order_details od
  INNER JOIN orders o ON o.orderID = od.orderID
  INNER JOIN cart_items ci ON ci.variantId = od.variantID AND ci.sizeId = od.sizeID AND ci.sellerID = o.sellerID
  WHERE o.delAddressId = 1 AND od.remainingSetCount > 0
    AND o.createdOn > UNIX_TIMESTAMP(DATE_ADD(CURDATE(), INTERVAL - 30 DAY))
    AND o.sellerID = ?
  GROUP BY od.variantID, od.sizeID, o.sellerID
)
SELECT ci.*, COALESCE(lo.lastOrderAgo, 30) as lastOrderAgo,
  MAX(DATEDIFF(CURRENT_DATE, FROM_UNIXTIME(rmlla.startEventDate))) as Ageing
FROM rm_lot_level_attribution rmlla
INNER JOIN cart_items ci ON rmlla.variantID = ci.variantID AND rmlla.sizeID = ci.sizeID AND rmlla.warehouseid = ci.fmWarehouseId
LEFT JOIN last_order lo ON rmlla.variantID = lo.variantID AND rmlla.sizeID = lo.sizeID
WHERE rmlla.activeStatus = 1 AND rmlla.isRemoved = 0 AND rmlla.soldDate = 0 AND rmlla.lotId > 0
GROUP BY rmlla.variantId, rmlla.sizeId, rmlla.warehouseid
    `,
    [SELLER_ID, PHONE, SELLER_ID]
  );
  console.log("\n8. Final query rows:", final.length);
  if (final.length > 0) {
    console.log("First row:", final[0]);
  }

  process.exit(0);
}

debug();
