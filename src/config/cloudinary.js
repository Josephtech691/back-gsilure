const { v2: cloudinary } = require('cloudinary');

const required = [
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
];

const missing = required.filter((key) => !process.env[key]);

if (!missing.length) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

function assertCloudinaryConfigured() {
  if (missing.length) {
    const err = new Error(
      `Stockage des avatars non configuré. Variables manquantes: ${missing.join(', ')}`
    );
    err.status = 503;
    throw err;
  }
}

module.exports = { cloudinary, assertCloudinaryConfigured };
