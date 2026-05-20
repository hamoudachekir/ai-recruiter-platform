const DEFAULT_MAX_DIMENSION = 1600;
const DEFAULT_QUALITY = 0.82;
const DEFAULT_SOURCE_LIMIT_MB = 30;
const DEFAULT_PROFILE_OUTPUT_SIZE = 900;
const DEFAULT_PROFILE_OUTPUT_QUALITY = 0.86;

const loadImage = (file) => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.onload = () => {
    URL.revokeObjectURL(url);
    resolve(image);
  };
  image.onerror = () => {
    URL.revokeObjectURL(url);
    reject(new Error('Could not read this image. Please choose a JPEG or PNG photo.'));
  };
  image.src = url;
});

const canvasToBlob = (canvas, type, quality) => new Promise((resolve) => {
  canvas.toBlob(resolve, type, quality);
});

export async function compressProfileImage(file, options = {}) {
  if (!file) return null;
  if (!file.type?.startsWith('image/')) {
    throw new Error('Only image files are allowed.');
  }

  const sourceLimitBytes = (options.sourceLimitMb || DEFAULT_SOURCE_LIMIT_MB) * 1024 * 1024;
  if (file.size > sourceLimitBytes) {
    throw new Error(`Image too large. Please choose a photo under ${options.sourceLimitMb || DEFAULT_SOURCE_LIMIT_MB}MB.`);
  }

  const image = await loadImage(file);
  const maxDimension = options.maxDimension || DEFAULT_MAX_DIMENSION;
  const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not prepare this image. Please try another photo.');
  }

  ctx.drawImage(image, 0, 0, width, height);
  const blob = await canvasToBlob(canvas, 'image/jpeg', options.quality || DEFAULT_QUALITY);
  if (!blob) {
    throw new Error('Could not optimize this image. Please try another photo.');
  }

  if (blob.size >= file.size && file.type === 'image/jpeg') {
    return file;
  }

  const originalName = file.name || 'profile-photo.jpg';
  const baseName = originalName.replace(/\.[^.]+$/, '') || 'profile-photo';
  return new File([blob], `${baseName}.jpg`, {
    type: 'image/jpeg',
    lastModified: Date.now(),
  });
}

export async function createAdjustedProfileImage(file, options = {}) {
  if (!file) return null;
  if (!file.type?.startsWith('image/')) {
    throw new Error('Only image files are allowed.');
  }

  const image = await loadImage(file);
  const size = options.size || DEFAULT_PROFILE_OUTPUT_SIZE;
  const zoom = Math.max(1, Math.min(Number(options.zoom) || 1, options.maxZoom || 2.5));
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not prepare this image. Please try another photo.');
  }

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  const coverScale = Math.max(size / image.width, size / image.height) * zoom;
  const drawWidth = image.width * coverScale;
  const drawHeight = image.height * coverScale;
  const drawX = (size - drawWidth) / 2;
  const drawY = (size - drawHeight) / 2;

  ctx.drawImage(image, drawX, drawY, drawWidth, drawHeight);

  const blob = await canvasToBlob(
    canvas,
    'image/jpeg',
    options.quality || DEFAULT_PROFILE_OUTPUT_QUALITY
  );

  if (!blob) {
    throw new Error('Could not adjust this image. Please try another photo.');
  }

  const originalName = file.name || 'profile-photo.jpg';
  const baseName = originalName.replace(/\.[^.]+$/, '') || 'profile-photo';
  return new File([blob], `${baseName}.jpg`, {
    type: 'image/jpeg',
    lastModified: Date.now(),
  });
}
