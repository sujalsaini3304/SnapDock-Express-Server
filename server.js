/**
 * Local development server.
 *
 * This file is ONLY used for local development (npm run dev).
 * Vercel uses api/index.js instead, which imports the app directly.
 */
import app from "./index.js";
import connectDB from "./config/db.js";
import dotenv from "dotenv";

dotenv.config({ path: ".env" });

const PORT = process.env.PORT || 8000;

connectDB()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`Dev server running on http://localhost:${PORT}`);
        });
    })
    .catch((err) => {
        console.error("Failed to connect to MongoDB:", err);
        process.exit(1);
    });
