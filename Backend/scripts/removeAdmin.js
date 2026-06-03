// One-off: delete the hamoudachkir2000@gmail.com ADMIN, keep admin@admin.com.
// Run: $env:NODE_PATH="C:\Users\wh\ai-recruiter-platform\Backend\server\node_modules"; node Backend/scripts/removeAdmin.js
require("dotenv").config({ path: require("path").join(__dirname, "..", "server", ".env") });
const mongoose = require("mongoose");
const { UserModel: User } = require("../server/models/user");

// Remove every ADMIN except this one.
const KEEP_EMAIL = "admin@admin.com";

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ Connected:", process.env.MONGO_URI);

  const res = await User.deleteMany({ role: "ADMIN", email: { $ne: KEEP_EMAIL } });
  console.log(`🗑️  Removed ${res.deletedCount} admin account(s); kept ${KEEP_EMAIL}`);

  const admins = await User.find({ role: "ADMIN" }, "email name");
  console.log("\nRemaining ADMIN accounts:");
  admins.forEach((a) => console.log(`  - ${a.email} (${a.name})`));

  await mongoose.disconnect();
})().catch((e) => { console.error("❌", e); process.exit(1); });
