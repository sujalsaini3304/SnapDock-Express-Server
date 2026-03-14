import express from "express";
import dotenv from "dotenv";
import cloudinary from "../config/cloudinary.js";
import { uploadLimiter } from "../middleware/rateLimit.middleware.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { Image } from "../model/model.js";
import { encrypt, decrypt } from "../utils/crypto.js";
import connectDB from "../config/db.js";
import {
  setCompressed,
  getCompressed,
  deleteCache,
  deleteCacheByPattern,
} from "../config/redis.js";

const router = express.Router();
dotenv.config({ path: ".env" });

const BATCH_CACHE_TTL = parseInt(process.env.SIGNED_URL_TTL_SECONDS || "600"); // 10 min default
const MAX_BATCH_SIZE = 500; // safety cap for very large accounts


// ──────────────────────────────────────────
// Helper: Build expiring Cloudinary signed URL
// ──────────────────────────────────────────
const buildExpiringAuthenticatedUrl = (publicId, format = "jpg") => {
  const expiresAt =
    Math.floor(Date.now() / 1000) +
    parseInt(process.env.SIGNED_URL_TTL_SECONDS || "600");

  const url = cloudinary.utils.private_download_url(publicId, format, {
    resource_type: "image",
    type: "private",
    expires_at: expiresAt,
    attachment: false,
  });

  return { url, expiresAt };
};


// ──────────────────────────────────────────
// Helper: Decrypt publicId safely
// ──────────────────────────────────────────
const safeDecrypt = (value) => {
  if (!value) return null;
  try {
    return decrypt(value);
  } catch (err) {
    console.error("Decrypt error:", err.message);
    return null;
  }
};


// ──────────────────────────────────────────
// Ping
// ──────────────────────────────────────────
router.get("/ping", (req, res) => {
  res.json({ message: "pong" });
});


// ──────────────────────────────────────────
// GET /api/images/batch
//
// Returns ALL user images with signed URLs.
// Frontend handles pagination locally.
//
// Flow:
//   1. Auth check (middleware, cached in Redis)
//   2. Check Redis for cached batch
//   3. Cache HIT  → return instantly
//   4. Cache MISS → query MongoDB (single query)
//                  → decrypt + sign all URLs
//                  → cache in Redis (compressed, 10 min)
//                  → return to frontend
// ──────────────────────────────────────────
router.get("/images/batch", authMiddleware, async (req, res) => {
  try {
    await connectDB();

    const userId = req.user.sub;
    const cacheKey = `batch:${userId}`;

    // 1. Check Redis cache (compressed)
    const cached = await getCompressed(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    // 2. Cache miss — query MongoDB
    //    Single query, no countDocuments needed (array length = total).
    //    Lean for raw JS objects (faster, less memory).
    //    Projection: only fetch fields we actually need.
    const images = await Image.find({ userId })
      .sort({ createdAt: -1 })
      .limit(MAX_BATCH_SIZE)
      .select("publicId format createdAt updatedAt")
      .lean();

    // 3. Decrypt + sign all URLs in one pass
    const data = images.map((item) => {
      const decryptedPublicId = safeDecrypt(item.publicId);
      const signed = decryptedPublicId
        ? buildExpiringAuthenticatedUrl(decryptedPublicId, item.format || "jpg")
        : null;

      return {
        _id: item._id,
        url: signed?.url || null,
        publicId: decryptedPublicId,
        urlExpiresAt: signed?.expiresAt || null,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      };
    });

    const response = {
      success: true,
      total: data.length,
      expiresAt: data[0]?.urlExpiresAt || null, // frontend uses this for auto-refresh
      data,
    };

    // 4. Cache in Redis (compressed, TTL = signed URL lifetime)
    await setCompressed(cacheKey, response, BATCH_CACHE_TTL);

    return res.json(response);

  } catch (error) {
    console.error("Batch fetch error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});


// ──────────────────────────────────────────
// GET /api/images  (kept for backward compatibility)
//
// Server-side paginated endpoint.
// Still useful as fallback for 500+ image accounts.
// ──────────────────────────────────────────
router.get("/images", authMiddleware, async (req, res) => {
  try {
    await connectDB();

    const userId = req.user.sub;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const sortOrder = req.query.sort === "asc" ? 1 : -1;
    const skip = (page - 1) * limit;

    const [images, total] = await Promise.all([
      Image.find({ userId })
        .sort({ createdAt: sortOrder })
        .skip(skip)
        .limit(limit)
        .select("publicId format createdAt updatedAt")
        .lean(),
      Image.countDocuments({ userId }),
    ]);

    const data = images.map((item) => {
      const decryptedPublicId = safeDecrypt(item.publicId);
      const signed = decryptedPublicId
        ? buildExpiringAuthenticatedUrl(decryptedPublicId, item.format || "jpg")
        : null;

      return {
        _id: item._id,
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


// ──────────────────────────────────────────
// POST /api/images/save
//
// Save image metadata after Cloudinary upload.
// Invalidates the user's batch cache.
// ──────────────────────────────────────────
router.post("/images/save", authMiddleware, async (req, res) => {
  try {
    await connectDB();

    const userId = req.user.sub;
    const email = req.user.email ?? null;

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

    // ── Invalidate caches ──
    await deleteCache(`batch:${userId}`);

    return res.status(201).json({
      message: "Images saved successfully",
      images: saved,
    });

  } catch (error) {
    console.error("Save images error:", error);
    return res.status(500).json({ message: "Server error" });
  }
});


// ──────────────────────────────────────────
// GET /api/signature
//
// Generate Cloudinary upload signature.
// No caching needed (unique per request).
// ──────────────────────────────────────────
router.get("/signature", uploadLimiter, authMiddleware, async (req, res) => {
  const userId = req.user.sub;
  const timestamp = Math.round(Date.now() / 1000);
  const folder = `SnapDock/data/${userId}/images`;
  const transformation = "f_auto,q_auto:best,w_2000";
  const type = "private";

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


// ──────────────────────────────────────────
// DELETE /api/images
//
// Delete selected images.
// Invalidates the user's batch cache.
// ──────────────────────────────────────────
router.delete("/images", authMiddleware, async (req, res) => {
  try {
    await connectDB();

    const userId = req.user.sub;
    const { ids } = req.body;

    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ message: "No image IDs provided" });
    }

    // Find images belonging to this user
    const images = await Image.find({ _id: { $in: ids }, userId })
      .select("publicId")
      .lean();
    if (!images.length) {
      return res.status(404).json({ message: "No images found" });
    }

    // Decrypt publicIds and delete from Cloudinary
    const publicIds = images
      .map((img) => {
        try { return decrypt(img.publicId); } catch { return null; }
      })
      .filter(Boolean);

    if (publicIds.length > 0) {
      try {
        await cloudinary.api.delete_resources(publicIds, {
          resource_type: "image",
          type: "private",
        });
      } catch (err) {
        console.error("Cloudinary delete error:", err.message);
      }
    }

    // Delete from MongoDB
    const result = await Image.deleteMany({ _id: { $in: ids }, userId });

    // ── Invalidate caches ──
    await deleteCache(`batch:${userId}`);

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


// ──────────────────────────────────────────
// DELETE /api/account
//
// Full account deletion.
// Clears ALL user data from Redis, MongoDB, Cloudinary, and Firebase.
// ──────────────────────────────────────────
router.delete("/account", authMiddleware, async (req, res) => {
  try {
    await connectDB();

    const userId = req.user.sub;

    // 1. Find all user images
    const userImages = await Image.find({ userId }).select("publicId").lean();
    const imageCount = userImages.length;

    // 2. Delete entire user folder from Cloudinary
    if (imageCount > 0) {
      try {
        const folderPath = `SnapDock/data/${userId}`;

        await cloudinary.api.delete_resources_by_prefix(folderPath, {
          resource_type: "image",
          type: "private",
        });

        await cloudinary.api.delete_folder(folderPath);

        console.log(`Deleted Cloudinary folder: ${folderPath}`);
      } catch (cloudinaryError) {
        console.error("Cloudinary deletion error:", cloudinaryError.message);
      }
    }

    // 3. Delete all image records from MongoDB
    await Image.deleteMany({ userId });

    // 4. Delete user from Firebase Auth
    try {
      const admin = (await import("../firebaseAdmin.config.js")).default;
      await admin.auth().deleteUser(userId);
      console.log(`Deleted Firebase user: ${userId}`);
    } catch (firebaseError) {
      console.error("Firebase user deletion error:", firebaseError.message);
      return res.status(500).json({
        success: false,
        message: "Failed to delete user account from authentication system"
      });
    }

    // 5. Purge ALL Redis caches for this user
    await deleteCache(`batch:${userId}`);
    await deleteCacheByPattern(`auth:*`); // Token cache will expire naturally via TTL, but clean up

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


export default router;
