const mongoose = require('mongoose');
const { Schema } = mongoose;

const DepartmentSchema = new Schema(
  {
    name:         { type: String, required: true, trim: true, maxlength: 80 },
    description:  { type: String, trim: true, maxlength: 400 },
    entrepriseId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  },
  { timestamps: true }
);

DepartmentSchema.index({ entrepriseId: 1, name: 1 }, { unique: true });

const DepartmentModel = mongoose.models.Department || mongoose.model('Department', DepartmentSchema);
module.exports = DepartmentModel;
