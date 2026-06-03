const mongoose = require('mongoose');
const { Schema } = mongoose;

const HEX_RE = /^#([0-9a-f]{3}){1,2}$/i;

const BrandColorsSchema = new Schema(
  {
    primary:   { type: String, match: HEX_RE },
    secondary: { type: String, match: HEX_RE },
    accent:    { type: String, match: HEX_RE },
  },
  { _id: false }
);

const CompanyContextSchema = new Schema(
  {
    name:         { type: String, required: true, trim: true, maxlength: 80 },
    website:      { type: String, trim: true, maxlength: 300 },
    industry:     { type: String, trim: true, maxlength: 120 },
    description:  { type: String, trim: true, maxlength: 1000 },
    brandColors:  { type: BrandColorsSchema, default: () => ({}) },
    entrepriseId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  },
  { timestamps: true }
);

CompanyContextSchema.index({ entrepriseId: 1, name: 1 }, { unique: true });

const CompanyContextModel =
  mongoose.models.CompanyContext || mongoose.model('CompanyContext', CompanyContextSchema);

module.exports = CompanyContextModel;
