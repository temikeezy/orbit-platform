import { useState, useRef, useId } from 'react';
import { Upload, Loader2, X } from 'lucide-react';

interface ImageUploadProps {
  currentImage?: string;
  onUpload: (file: File) => Promise<string>;
  onRemove?: () => void;
  label: string;
  aspectRatio?: 'square' | 'wide' | 'tall';
  maxSizeMB?: number;
}

export function ImageUpload({
  currentImage,
  onUpload,
  onRemove,
  label,
  aspectRatio = 'square',
  maxSizeMB = 5,
}: ImageUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(currentImage || null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // This component mounts twice on the profile-edit page (cover + avatar), so
  // the id must be per-instance, never a literal.
  const fileInputId = useId();

  const getAspectRatioClass = () => {
    switch (aspectRatio) {
      case 'wide':
        return 'aspect-[16/9]';
      case 'tall':
        return 'aspect-[9/16]';
      default:
        return 'aspect-square';
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);

    if (file.size > maxSizeMB * 1024 * 1024) {
      setError(`File size must be less than ${maxSizeMB}MB`);
      return;
    }

    if (!file.type.startsWith('image/')) {
      setError('Please select an image file');
      return;
    }

    const reader = new FileReader();
    reader.onloadend = () => {
      setPreview(reader.result as string);
    };
    reader.readAsDataURL(file);

    try {
      setUploading(true);
      await onUpload(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload image');
      setPreview(currentImage || null);
    } finally {
      setUploading(false);
    }
  };

  const handleRemove = () => {
    setPreview(null);
    setError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    if (onRemove) {
      onRemove();
    }
  };

  return (
    <div className="space-y-2">
      <label htmlFor={fileInputId} className="block text-sm font-medium text-slate-700">{label}</label>

      <div className={`relative ${getAspectRatioClass()} w-full bg-slate-100 rounded-lg overflow-hidden border-2 border-dashed border-slate-300 hover:border-iih-green transition-colors`}>
        {preview ? (
          <div className="relative w-full h-full group">
            <img
              src={preview}
              alt="Preview"
              className="w-full h-full object-cover"
            />
            <div className="absolute inset-0 bg-black bg-opacity-40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="bg-white text-slate-800 px-4 py-2 rounded-lg font-medium hover:bg-slate-100 transition-colors flex items-center gap-2"
              >
                <Upload className="w-4 h-4" />
                Change
              </button>
              {onRemove && (
                <button
                  type="button"
                  onClick={handleRemove}
                  disabled={uploading}
                  className="bg-red-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-red-700 transition-colors flex items-center gap-2"
                >
                  <X className="w-4 h-4" />
                  Remove
                </button>
              )}
            </div>
            {uploading && (
              <div className="absolute inset-0 bg-black bg-opacity-50 flex items-center justify-center">
                <Loader2 className="w-8 h-8 text-white animate-spin" />
              </div>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="w-full h-full flex flex-col items-center justify-center gap-2 text-slate-600 hover:text-iih-green transition-colors"
          >
            {uploading ? (
              <>
                <Loader2 className="w-8 h-8 animate-spin" />
                <span className="text-sm font-medium">Uploading...</span>
              </>
            ) : (
              <>
                <Upload className="w-8 h-8" />
                <span className="text-sm font-medium">Click to upload</span>
                <span className="text-xs text-slate-500">Max {maxSizeMB}MB</span>
              </>
            )}
          </button>
        )}

        <input
          ref={fileInputRef}
          id={fileInputId}
          type="file"
          accept="image/*"
          onChange={handleFileSelect}
          className="hidden"
        />
      </div>

      {error && (
        <p className="text-sm text-red-600">{error}</p>
      )}
    </div>
  );
}
