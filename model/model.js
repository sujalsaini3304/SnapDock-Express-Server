import mongoose from "mongoose";

const imageSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      index: true
    },

    email: {
      type: String,
      required: true,
      index: true
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


const Image = mongoose.models.Image || mongoose.model("Image", imageSchema);

export {
  Image,
}