import { config } from "dotenv";
config({ path: ".env.local" });
import { RowDataPacket } from "mysql2";
import pool from "../lib/db";

const SELLER_ID = process.env.SELLER_ID || "1490492473";
const TEST_PHONE = process.argv[2] || "9876543210";

async function test() {
  console.log("Testing DB connection...");
  console.log("Host:", process.env.DB_HOST);
  console.log("User:", process.env.DB_USER);
  console.log("Database:", process.env.DB_NAME);
  console.log("Seller ID:", SELLER_ID);
  console.log("Test Phone:", TEST_PHONE);

  try {
    const connection = await pool.getConnection();
    console.log("✅ Connected to MySQL");

    try {
      // Test 1: Does user_master have the phone?
      const [userRows] = await connection.execute<RowDataPacket[]>(
        `SELECT userid, companyPhone, phone FROM user_master WHERE companyPhone = ? LIMIT 1`,
        [TEST_PHONE]
      );
      console.log("\nUser lookup:", userRows.length > 0 ? userRows[0] : "NOT FOUND");

      // Test 2: Does truck_items have data for this seller?
      const [truckRows] = await connection.execute<RowDataPacket[]>(
        `SELECT COUNT(*) as cnt FROM truck_items WHERE sellerid = ? AND status = 0 AND orderType = 'OnStock'`,
        [SELLER_ID]
      );
      console.log("Truck items count:", truckRows[0]);

      // Test 3: Run the full query
      console.log("\nRunning full cart query...");
      const [rows] = await connection.execute<RowDataPacket[]>(
        `
WITH cart_items AS (
  SELECT 
    ti.userID, ti.sellerID, sma.fmWarehouseId, ti.productID, ti.variantID, ti.sizeID,
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
GROUP BY rmlla.variantId, rmlla.sizeId, rmlla.warehouseid;
        `,
        [SELLER_ID, TEST_PHONE, SELLER_ID]
      );

      console.log("✅ Query succeeded");
      console.log("Rows returned:", rows.length);
      if (rows.length > 0) {
        console.log("First row:", rows[0]);
      } else {
        console.log("⚠️ No cart items found for this phone + seller");
      }
    } catch (queryErr) {
      console.error("❌ Query failed:", queryErr);
    } finally {
      connection.release();
    }
  } catch (connErr) {
    console.error("❌ Connection failed:", connErr);
  }

  process.exit(0);
}

test();
