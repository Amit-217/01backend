const express = require("express");
const cors = require("cors");
const swaggerUi = require("swagger-ui-express");
const swaggerJsdoc = require("swagger-jsdoc");
require("dotenv").config();

const { AppError } = require("./common/utils/errors");
const authRoutes = require("./modules/tenant/auth/auth.route");
const { isAllowedWebOrigin } = require("./modules/tenant/auth/auth.web");
const userRoutes = require("./modules/tenant/users/user.route");
const tenantRoutes = require("./modules/tenant/tenant/tenant.route");
const rawMaterialCategoryRoutes = require("./modules/raw_material/category/category.route");
const rawMaterialRoutes = require("./modules/raw_material/raw_material/raw.material.route");
const vendorRoutes = require("./modules/raw_material/vendor/vendor.route");
const materialTransactionRoutes = require("./modules/raw_material/material_transaction/material.transaction.route");
const platformRoutes = require("./modules/platform/platform.route");
const finishedGoodsRoutes = require("./modules/finished_goods/finished.route");

const app = express();
const proxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
if (Number.isInteger(proxyHops) && proxyHops > 0) app.set("trust proxy", proxyHops);

const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Viplora SaaS Backend",
      version: "1.0.0",
      description: "Tenant auth, user, and SaaS foundation APIs.",
    },
  },
  apis: ["./src/modules/**/*.js", "./src/*.js"],
});

app.use(cors((req, callback) => callback(null, {
  origin: isAllowedWebOrigin(req) ? req.get("Origin") : false,
  credentials: true,
})));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/tenants", tenantRoutes);
app.use("/api/v1/raw-material-categories", rawMaterialCategoryRoutes);
app.use("/api/v1/raw-materials", rawMaterialRoutes);
app.use("/api/v1/vendors", vendorRoutes);
app.use("/api/v1/material-transactions", materialTransactionRoutes);
app.use("/api/v1/finished-goods", finishedGoodsRoutes);
app.use("/api/platform", platformRoutes);
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Backend is running",
    timestamp: new Date().toISOString(),
  });
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found.",
  });
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  let statusCode = 500;
  let message = "Something went wrong on the server.";
  if (error instanceof AppError) {
    statusCode = error.statusCode;
    message = error.message;
  } else if (error.code === 11000) {
    statusCode = 409;
    message = "A record with these details already exists.";
  } else if (error.name === "CastError" || error.type === "entity.parse.failed") {
    statusCode = 400;
    message = "The request contains an invalid value.";
  }

  if (statusCode >= 500) {
    console.error("API Error:", {
      method: req.method,
      url: req.path,
      message: error.message || message,
      stack: error.stack,
    });
  }

  return res.status(statusCode).json({
    success: false,
    message,
    ...(error && error.details ? { details: error.details } : {}),
    ...(statusCode >= 500 && process.env.NODE_ENV !== "production" && error.stack ? { stack: error.stack } : {}),
  });
});

module.exports = app;
