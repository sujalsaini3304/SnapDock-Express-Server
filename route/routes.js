import express from "express";
import dotenv from "dotenv";
import cloudinary from "../config/cloudinary.js";
import { uploadLimiter } from "../middleware/rateLimit.middleware.js";
import { Image } from "../model/model.js";
import { encrypt, decrypt } from "../utils/crypto.js";
import connectDB from "../config/db.js";
import admin from "../firebaseAdmin.config.js";

const router = express.Router();
dotenv.config({
  path: ".env"
})

// const SIGNED_URL_TTL_SECONDS = 60;

const buildExpiringAuthenticatedUrl = (publicId, format = "jpg") => {
  const expiresAt = Math.floor(Date.now() / 1000) + process.env.SIGNED_URL_TTL_SECONDS;

  // private_download_url enforces expires_at and works with authenticated assets
  const url = cloudinary.utils.private_download_url(publicId, format, {
    resource_type: "image",
    type: "authenticated",
    expires_at: expiresAt,
    attachment: false,
  });

  return { url, expiresAt };
};


const verifyBearerToken = async (req) => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.split("Bearer ")[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);

    return {
      sub: decodedToken.uid,
      email: decodedToken.email || null,
    };
  } catch (err) {
    console.log("Firebase verify failed:", err.message);
    return null;
  }
};




router.get("/ping", (req, res) => {
  res.json({ message: "pong" });
});


// ===================================== Data Fetch Route ==================================
/*
  GET /api/images?page=1&limit=10&sort=desc
*/
router.get("/images", async (req, res) => {
  try {
    await connectDB();
    const payload = await verifyBearerToken(req);
    if (!payload) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const userId = payload.sub;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const sortOrder = req.query.sort === "asc" ? 1 : -1;
    const skip = (page - 1) * limit;

    const [images, total] = await Promise.all([
      Image.find({ userId })
        .sort({ createdAt: sortOrder })
        .skip(skip)
        .limit(limit)
        .lean(),
      Image.countDocuments({ userId }),
    ]);

    const safeDecrypt = (value) => {
      if (!value) return null;
      try { return decrypt(value); }
      catch (err) { console.error("Decrypt error:", err.message); return null; }
    };

    const data = images.map((item) => {
      const decryptedPublicId = safeDecrypt(item.publicId);
      const signed = decryptedPublicId
        ? buildExpiringAuthenticatedUrl(decryptedPublicId, item.format || "jpg")
        : null;

      return {
        _id: item._id,
        // Returns a one-minute expiring authenticated URL.
        url: signed?.url || null,
        publicId: decryptedPublicId,
        urlExpiresAt: signed?.expiresAt || null,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      };
    });

    return res.json({
      success: true,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      data,
    });

  } catch (error) {
    console.error("Fetch images error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});
// =================================================================================




// ===================================== Image upload Route ==================================
router.post("/images/save", async (req, res) => {
  try {
    await connectDB();
    const payload = await verifyBearerToken(req);
    if (!payload) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // Extract userId and email from the SnapDock JWT template claims
    const userId = payload.sub;
    const email = payload.email ?? null;

    const { images } = req.body;
    if (!images || !images.length) {
      return res.status(400).json({ message: "No images provided" });
    }

    const docs = images.map((img) => ({
      userId,
      email,
      publicId: encrypt(img.public_id),
      url: encrypt(img.secure_url),
      format: img.format,
      bytes: img.bytes,
      width: img.width,
      height: img.height,
    }));

    const saved = await Image.insertMany(docs);

    return res.status(201).json({
      message: "Images saved successfully",
      images: saved,
    });

  } catch (error) {
    console.error("Save images error:", error);
    return res.status(500).json({ message: "Server error" });
  }
});
// ===================================================================================



// ===================================== Signature Route ==================================
router.get("/signature", uploadLimiter, async (req, res) => {
  const payload = await verifyBearerToken(req);
  if (!payload) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const userId = payload.sub;
  const timestamp = Math.round(Date.now() / 1000);
  const folder = `SnapDock/data/${userId}/images`;
  const transformation = "f_auto,q_auto:best,w_2000";
  const type = "authenticated";

  const signature = cloudinary.utils.api_sign_request(
    {
      timestamp,
      folder,
      type,
      allowed_formats: "jpg,png,jpeg,webp",
      transformation,
    },
    process.env.CLOUDINARY_API_SECRET
  );

  return res.json({
    timestamp,
    signature,
    apiKey: process.env.CLOUDINARY_API_KEY,
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    folder,
    type,
    transformation,
  });

});

// ======================================================================================


// ===================================== Delete Images Route ==================================
router.delete("/images", async (req, res) => {
  try {
    await connectDB();
    const payload = await verifyBearerToken(req);
    if (!payload) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const userId = payload.sub;
    const { ids } = req.body;

    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ message: "No image IDs provided" });
    }

    // Find images belonging to this user
    const images = await Image.find({ _id: { $in: ids }, userId }).lean();
    if (!images.length) {
      return res.status(404).json({ message: "No images found" });
    }

    // Decrypt publicIds and delete from Cloudinary
    const publicIds = images
      .map((img) => { try { return decrypt(img.publicId); } catch { return null; } })
      .filter(Boolean);

    if (publicIds.length > 0) {
      try {
        await cloudinary.api.delete_resources(publicIds, {
          resource_type: "image",
          type: "authenticated",
        });
      } catch (err) {
        console.error("Cloudinary delete error:", err.message);
        // Continue to delete from DB even if Cloudinary fails
      }
    }

    // Delete from MongoDB
    const result = await Image.deleteMany({ _id: { $in: ids }, userId });

    return res.json({
      success: true,
      deleted: result.deletedCount,
      message: `${result.deletedCount} image(s) deleted successfully`,
    });

  } catch (error) {
    console.error("Delete images error:", error);
    return res.status(500).json({ message: "Server error" });
  }
});
// ============================================================================================






// ===================================== Delete Account Route ==================================
router.delete("/account", async (req, res) => {
  try {
    await connectDB();
    const payload = await verifyBearerToken(req);
    if (!payload) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const userId = payload.sub;

    // 1. Delete all images from MongoDB and get their public IDs
    const userImages = await Image.find({ userId }).lean();
    const imageCount = userImages.length;

    // 2. Delete entire user folder from Cloudinary
    if (imageCount > 0) {
      try {
        const folderPath = `SnapDock/data/${userId}`;

        // Delete all resources in the folder
        await cloudinary.api.delete_resources_by_prefix(folderPath, {
          resource_type: "image",
          type: "authenticated",
        });

        // Delete the folder itself
        await cloudinary.api.delete_folder(folderPath);

        console.log(`Deleted Cloudinary folder: ${folderPath}`);
      } catch (cloudinaryError) {
        console.error("Cloudinary deletion error:", cloudinaryError.message);
        // Continue even if Cloudinary deletion fails
      }
    }

    // 3. Delete all image records from MongoDB
    await Image.deleteMany({ userId });

    // 4. Delete user from Clerk
    try {
      // await clerkClient.users.deleteUser(userId);
      await admin.auth().deleteUser(userId);
      console.log(`Deleted Clerk user: ${userId}`);
    } catch (clerkError) {
      console.error("Clerk user deletion error:", clerkError.message);
      return res.status(500).json({
        success: false,
        message: "Failed to delete user account from authentication system"
      });
    }

    return res.json({
      success: true,
      message: "Account deleted successfully",
      deletedImages: imageCount,
    });

  } catch (error) {
    console.error("Delete account error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});
// ============================================================================================




export default router;
