import mongoose from "mongoose";

const imageSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
    },

    email: {
      type: String,
      required: true,
    },

    publicId: {
      type: String,
      required: true
    },

    url: {
      type: String,
      required: true
    },

    format: String,
    bytes: Number,

    width: Number,
    height: Number
  },
  {
    timestamps: true
  }
);

// Compound index — covers the main query pattern:
//   Image.find({ userId }).sort({ createdAt: -1 })
// MongoDB uses this single index for BOTH filtering and sorting.
// Replaces the two separate indexes on userId and email.
imageSchema.index({ userId: 1, createdAt: -1 });

const Image = mongoose.models.Image || mongoose.model("Image", imageSchema);

export {
  Image,
}