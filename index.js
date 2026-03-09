import express from "express";
import router from "./route/routes.js";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import cors from "cors";


dotenv.config({ path: ".env" });

const app = express();


app.set("trust proxy", 1);
// app.use((req, res, next) => {
//   console.log("Headers Received:", req.headers);
//   next();
// });


// Restrict CORS in production and allow localhost during development.
const allowedOrigins = [process.env.TRUSTED_ENDPOINT];

if (process.env.NODE_ENV !== "production") {
  allowedOrigins.push("http://localhost:5173");
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400 // 24 hours
  })
);

app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());


app.get("/", (req, res) => {
  res.json({ message: "Server started" });
});

app.use("/api", router);

app.listen(process.env.PORT, () => {
  console.log("Express server started.");
});