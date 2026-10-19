const multer = require('multer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 40 },
  fileFilter: (req, file, cb) => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.mimetype)) {
      const err = new Error('Only JPEG, PNG, or WEBP images are allowed.');
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  },
});

module.exports = upload;
