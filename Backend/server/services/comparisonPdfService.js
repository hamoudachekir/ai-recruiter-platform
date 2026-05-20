const PDFDocument = require("pdfkit");

const fmtScore = (n) => {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  return Number(n).toFixed(1);
};

const fmtDate = (d) => {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString();
  } catch {
    return String(d);
  }
};

/**
 * Stream a ranked-comparison PDF report into the given writable stream
 * (typically an Express response).
 */
function buildComparisonPdf({ room, comparison }, stream) {
  const doc = new PDFDocument({ size: "A4", margin: 48 });
  doc.pipe(stream);

  // Header
  doc
    .fontSize(20)
    .fillColor("#1a1a1a")
    .text("Candidate Comparison Report", { align: "left" });
  doc.moveDown(0.3);
  doc
    .fontSize(11)
    .fillColor("#444")
    .text(`Job: ${room.job?.title || "Untitled"}`)
    .text(`Room: ${room.title || room.slug}`)
    .text(`Generated: ${fmtDate(comparison.generatedAt)}`)
    .text(`Candidates ranked: ${comparison.rankings.length}`);
  doc.moveDown(0.7);

  // Executive summary
  if (comparison.executiveSummary) {
    doc
      .fontSize(13)
      .fillColor("#1a1a1a")
      .text("Executive Summary", { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor("#222").text(comparison.executiveSummary, {
      align: "left",
      lineGap: 2,
    });
    doc.moveDown(0.8);
  }

  doc
    .fontSize(13)
    .fillColor("#1a1a1a")
    .text("Leaderboard", { underline: true });
  doc.moveDown(0.3);

  // Per-candidate detail blocks
  comparison.rankings.forEach((row, idx) => {
    if (idx > 0) doc.moveDown(0.6);
    if (doc.y > 720) doc.addPage();

    doc
      .fontSize(12)
      .fillColor("#0b3d91")
      .text(`#${row.rank}  ${row.candidateName || "Unknown candidate"}`, {
        continued: true,
      })
      .fillColor("#555")
      .text(`   —  ${fmtScore(row.suitabilityScore)} / 100`);
    doc.moveDown(0.2);

    if (row.candidateEmail) {
      doc.fontSize(9).fillColor("#777").text(row.candidateEmail);
    }

    doc.moveDown(0.25);
    doc.fontSize(10).fillColor("#222");
    if (row.strongestPoint) {
      doc.font("Helvetica-Bold").text("Strongest point: ", { continued: true });
      doc.font("Helvetica").text(row.strongestPoint);
    }
    if (row.mainWeakness) {
      doc.font("Helvetica-Bold").text("Main weakness: ", { continued: true });
      doc.font("Helvetica").text(row.mainWeakness);
    }
    if (row.hiringRecommendation) {
      doc.font("Helvetica-Bold").text("Recommendation: ", { continued: true });
      doc.font("Helvetica").text(row.hiringRecommendation);
    }
    if (row.justification) {
      doc.moveDown(0.15);
      doc.fontSize(9.5).fillColor("#444").text(row.justification, {
        lineGap: 1.5,
      });
    }

    const m = row.metrics || {};
    const metricsLine = [
      m.technicalTheta != null ? `θ ${fmtScore(m.technicalTheta)}` : null,
      m.technicalScore != null ? `Tech ${fmtScore(m.technicalScore)}` : null,
      m.hrScore != null ? `HR ${fmtScore(m.hrScore)}` : null,
      m.integrityScore != null ? `Integrity ${fmtScore(m.integrityScore)}` : null,
      m.resilienceIndex != null
        ? `Resilience ${fmtScore(m.resilienceIndex)}`
        : null,
      m.sentimentScore != null
        ? `Sentiment ${fmtScore(m.sentimentScore)}`
        : null,
    ]
      .filter(Boolean)
      .join("  •  ");
    if (metricsLine) {
      doc.moveDown(0.15);
      doc.fontSize(8.5).fillColor("#666").text(metricsLine);
    }
  });

  doc.moveDown(1);
  doc
    .fontSize(8)
    .fillColor("#888")
    .text(
      "This ranking is produced by an AI agent based on structured interview reports. " +
        "Use it as an input to human decision-making, not as a standalone hiring decision.",
      { align: "center" },
    );

  doc.end();
}

module.exports = { buildComparisonPdf };
