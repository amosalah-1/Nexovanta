(function (root) {
  'use strict';

  const BUCKET = 'shop-media';
  const MAX_FILE_SIZE = 8 * 1024 * 1024;
  const MAX_IMAGE_EDGE = 1800;
  const THUMB_EDGE = 480;
  const MAX_UPLOAD_ATTEMPTS = 3;

  function getDatabase() {
    if (typeof NexovantaDB !== 'undefined') return NexovantaDB;
    return root.NexovantaDB || null;
  }

  function getClient() {
    const database = getDatabase();
    const client = database && database.supabase;
    if (!client || !client.storage) {
      throw new Error('Image uploads require a configured Supabase connection.');
    }
    return client;
  }

  function createObjectUrl(file) {
    return URL.createObjectURL(file);
  }

  function revokeObjectUrl(url) {
    if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
  }

  async function toBlob(canvas, type, quality) {
    if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not process this image.')), type, quality);
    });
  }

  async function createImageBlob(file, maxEdge, quality, outputType, aspectRatio) {
    let bitmap;
    let image;
    try {
      if (root.createImageBitmap) {
        bitmap = await root.createImageBitmap(file);
        image = bitmap;
      } else {
        image = await new Promise((resolve, reject) => {
          const element = new Image();
          const objectUrl = createObjectUrl(file);
          element.onload = () => {
            revokeObjectUrl(objectUrl);
            resolve(element);
          };
          element.onerror = () => {
            revokeObjectUrl(objectUrl);
            reject(new Error('Could not open this image. Choose a JPG, PNG, or WebP photo.'));
          };
          element.src = objectUrl;
        });
      }

      let sourceX = 0;
      let sourceY = 0;
      let sourceWidth = image.width;
      let sourceHeight = image.height;
      if (aspectRatio) {
        if (sourceWidth / sourceHeight > aspectRatio) {
          sourceWidth = sourceHeight * aspectRatio;
          sourceX = (image.width - sourceWidth) / 2;
        } else {
          sourceHeight = sourceWidth / aspectRatio;
          sourceY = (image.height - sourceHeight) / 2;
        }
      }
      const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      const canvas = root.OffscreenCanvas
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement('canvas'), { width, height });
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('This browser cannot process images.');
      context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);
      return await toBlob(canvas, outputType, quality);
    } finally {
      if (bitmap) bitmap.close();
    }
  }

  async function uploadWithRetry(path, blob) {
    const client = getClient();
    let lastError;
    for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt += 1) {
      const { error } = await client.storage.from(BUCKET).upload(path, blob, {
        cacheControl: '31536000',
        contentType: blob.type,
        upsert: false
      });
      if (!error) return;
      lastError = error;
      if (attempt < MAX_UPLOAD_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, attempt * 500));
      }
    }
    throw new Error(`Image upload failed after ${MAX_UPLOAD_ATTEMPTS} attempts: ${lastError.message}`);
  }

  async function upload(shopId, area, file, onStage, options = {}) {
    if (!shopId || !/^[a-zA-Z0-9_-]+$/.test(shopId)) throw new Error('Invalid shop ID.');
    if (!(file instanceof Blob) || !file.type.startsWith('image/')) {
      throw new Error('Choose a valid image file.');
    }
    if (file.size > MAX_FILE_SIZE) throw new Error('Each image must be 8 MB or smaller.');

    onStage?.('Optimizing image…');
    const full = await createImageBlob(file, MAX_IMAGE_EDGE, 0.84, 'image/jpeg', options.aspectRatio);
    const thumbnail = await createImageBlob(file, THUMB_EDGE, 0.76, 'image/jpeg', options.aspectRatio);
    const database = getDatabase();
    if (!database || typeof database.uuid !== 'function') throw new Error('Nexovanta database is not ready.');
    const id = database.uuid();
    const folder = area === 'gallery' ? 'gallery' : area === 'product' ? 'products' : 'branding';
    const basePath = `${shopId}/${folder}/${id}`;
    const path = `${basePath}.jpg`;
    const thumbnailPath = `${basePath}-thumb.jpg`;
    const client = getClient();
    let fullUploaded = false;

    try {
      onStage?.('Uploading image…');
      await uploadWithRetry(path, full);
      fullUploaded = true;
      await uploadWithRetry(thumbnailPath, thumbnail);
      const publicUrl = client.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
      const thumbnailUrl = client.storage.from(BUCKET).getPublicUrl(thumbnailPath).data.publicUrl;
      return {
        id,
        path,
        url: publicUrl,
        thumbnail_path: thumbnailPath,
        thumbnail_url: thumbnailUrl,
        caption: '',
        alt_text: String(file.name || 'Shop photo').slice(0, 160)
      };
    } catch (error) {
      const paths = fullUploaded ? [path, thumbnailPath] : [path];
      const { error: cleanupError } = await client.storage.from(BUCKET).remove(paths);
      if (cleanupError) {
        throw new Error(`${error.message} Temporary image cleanup failed: ${cleanupError.message}`);
      }
      throw error;
    }
  }

  function getStoragePaths(image) {
    if (!image || typeof image !== 'object') return [];
    return [image.path, image.thumbnail_path]
      .filter(path => typeof path === 'string' && path.length > 0);
  }

  async function remove(shopId, images) {
    if (!shopId || !/^[a-zA-Z0-9_-]+$/.test(shopId)) throw new Error('Invalid shop ID.');
    const paths = (Array.isArray(images) ? images : [images])
      .flatMap(getStoragePaths)
      .filter(path => path.startsWith(`${shopId}/`));
    if (!paths.length) return;
    const { error } = await getClient().storage.from(BUCKET).remove(paths);
    if (error) throw new Error(`Could not remove stored images: ${error.message}`);
  }

  root.NexovantaMarketplaceImages = Object.freeze({
    createObjectUrl,
    revokeObjectUrl,
    upload,
    remove
  });
})(window);
