// One-off: create/ensure an ADMIN user that can log in at /dashboard.
// Run:  $env:NODE_PATH="C:\Users\wh\ai-recruiter-platform\Backend\server\node_modules"; node Backend/scripts/addAdmin.js
require("dotenv").config({ path: require("path").join(__dirname, "..", "server", ".env") });
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const { UserModel: User } = require("../server/models/user");

const EMAIL = "admin@admin.com";
const PASSWORD = "Admin123!";
const NAME = "Administrator";

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ Connected:", process.env.MONGO_URI);

  const hash = await bcrypt.hash(PASSWORD, 10);
  const fields = {
    name: NAME,
    role: "ADMIN",
    password: hash,
    isActive: true,
    verificationStatus: { status: "APPROVED", emailVerified: true },
    permissions: { canManageUsers: true, canControlPermissions: true, canOverseeSystem: true },
  };

  const existing = await User.findOne({ email: EMAIL });
  if (existing) {
    Object.assign(existing, fields);
    await existing.save();
    console.log(`♻️  Updated existing user -> ADMIN: ${EMAIL}`);
  } else {
    await User.create({ email: EMAIL, ...fields });
    console.log(`🆕 Created ADMIN: ${EMAIL}`);
  }

  console.log("\n  Login at http://localhost:5173/dashboard");
  console.log(`  Email:    ${EMAIL}`);
  console.log(`  Password: ${PASSWORD}\n`);
  await mongoose.disconnect();
})().catch((e) => { console.error("❌", e); process.exit(1); });
