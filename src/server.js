const app = require("./app");
const connectDB = require("./config/db.config");
const { getAccessTokenSecret } = require("./common/utils/helpers");
const MaterialTransaction = require("./modules/raw_material/material_transaction/material.transaction.model");
const Vendor = require("./modules/raw_material/vendor/vendor.model");
const Session = require("./modules/tenant/auth/session.model");
const User = require("./modules/tenant/users/user.model");
const platformModels = require("./modules/platform/platform.model");
const { FinishedProduct, FinishedSku, FinishedMovement } = require("./modules/finished_goods/finished.model");

const PORT = Number(process.env.PORT) || 4000;

const startServer = async () => {
  try {
    getAccessTokenSecret();
    await connectDB();
    await Promise.all([MaterialTransaction, Vendor, Session, User, FinishedProduct, FinishedSku, FinishedMovement, ...Object.values(platformModels)]
      .map((model) => model.createIndexes()));

    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error.message);
    process.exit(1);
  }
};

startServer();
