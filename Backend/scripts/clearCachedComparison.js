/**
 * Drop the cached ComparisonReport(s) for a jobInterviewRoom so a fresh
 * re-rank picks up newly-linked candidates instead of returning the
 * stored rankings from the previous run.
 *
 * Usage:
 *   node Backend/scripts/clearCachedComparison.js feed000000000000000000e2
 */
const path = require("path");
const serverDir = path.join(__dirname, "..", "server");
module.paths.unshift(path.join(serverDir, "node_modules"));
require("dotenv").config({ path: path.join(serverDir, ".env") });

const mongoose = require("mongoose");

async function main() {
  const jirArg = process.argv[2];
  if (!jirArg) {
    console.error("Usage: node clearCachedComparison.js <jobInterviewRoomId>");
    process.exit(2);
  }

  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/ai_recruiter");
  const db = mongoose.connection.db;

  const jirId = new mongoose.Types.ObjectId(jirArg);
  const before = await db.collection("comparisonreports")
    .find({ jobInterviewRoom: jirId })
    .toArray();
  console.log(`Found ${before.length} cached ComparisonReport(s) for jobInterviewRoom=${jirArg}.`);

  if (before.length === 0) {
    console.log("Nothing to delete.");
  } else {
    const res = await db.collection("comparisonreports").deleteMany({ jobInterviewRoom: jirId });
    console.log(`Deleted ${res.deletedCount} cached report(s).`);
  }

  console.log("\nNext steps:");
  console.log("  1. Reload the Candidate Comparison page in the recruiter dashboard.");
  console.log("  2. Click 'Re-analyze' (or the equivalent generate-comparison button).");
  console.log("  3. The new ranking will include all 5 candidates.");

  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
