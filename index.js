import express from "express";
import router from "./route/routes.js";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import { clerkMiddleware } from "@clerk/express";
import cors from "cors";
import connectDB from "./config/db.js";

dotenv.config({ path: ".env" });

const app = express();


app.set("trust proxy", 1);
// app.use((req, res, next) => {
//   console.log("Headers Received:", req.headers);
//   next();
// });


// Enhanced CORS configuration
app.use(cors({
  origin: true,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400 // 24 hours
}));

app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
connectDB()

app.use(clerkMiddleware({
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
  secretKey: process.env.CLERK_SECRET_KEY,
  authorizedParties: [
    process.env.TRUSTED_ENDPOINT

    // For development and debug only
    // "http://localhost:5173",
    // /\.trycloudflare\.com$/ // Allow any Cloudflare tunnel URL

  ],
}));



app.get("/", (req, res) => {
  res.json({ message: "Server started" });
});

app.use("/api", router);

app.listen(process.env.PORT, () => {
  console.log("Express server started.");
});