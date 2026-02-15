const { execSync } = require("child_process");
const path = require("path");

exports.default = async function (context) {
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
  console.log(`Ad-hoc signing: ${appPath}`);
  try {
    execSync(`codesign --deep --force --sign - "${appPath}"`, {
      stdio: "inherit",
    });
    console.log("Ad-hoc signing complete");
  } catch (err) {
    console.warn("Ad-hoc signing failed (non-fatal):", err.message);
  }
};
