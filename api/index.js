/**
 * Vercel Serverless Function entry point.
 *
 * Vercel routes all requests here via vercel.json rewrites.
 * The Express app handles routing internally.
 */
import app from "../index.js";

export default app;
