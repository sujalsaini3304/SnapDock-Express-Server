import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME;

if (!MONGODB_URI) {
  throw new Error("MONGODB_URI is not defined in environment variables");
}

// global cache for serverless / clustering
let cached = globalThis.mongoose;

if (!cached) {
  cached = globalThis.mongoose = {
    conn: null,
    promise: null,
  };
}

async function connectDB() {
  try {
    // reuse existing connection
    if (cached.conn) {
      return cached.conn;
    }

    // create new connection promise
    if (!cached.promise) {
      const options = {
        bufferCommands: false,
        dbName: DB_NAME,
        maxPoolSize: 50,   // max connections per worker
        minPoolSize: 5,    // keep at least 5 connections warm
        socketTimeoutMS: 30000,  // close idle sockets after 30s
        serverSelectionTimeoutMS: 10000,  // fail fast if DB unreachable
      };

      cached.promise = mongoose.connect(MONGODB_URI, options);
    }

    cached.conn = await cached.promise;

    console.log("MongoDB connected");

    return cached.conn;

  } catch (error) {
    cached.promise = null;
    console.error("MongoDB connection error:", error);
    throw error;
  }
}

export default connectDB;
