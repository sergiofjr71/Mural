export interface PhotoAssetInfo {
  id: string;
  creationDate: string;
  width: number;
  height: number;
}

export interface PhotoLibraryPermissionResult {
  granted: boolean;
  status: 'authorized' | 'limited' | 'denied' | 'restricted' | 'notDetermined' | 'unknown';
}

export interface GetAllPhotosResult {
  photos: PhotoAssetInfo[];
  total: number;
}

export interface GetPhotoOptions {
  id: string;
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
}

export interface GetPhotoResult {
  id: string;
  path: string;
  webPath: string;
  width: number;
  height: number;
}

export interface PhotoLibraryPlugin {
  requestPermission(): Promise<PhotoLibraryPermissionResult>;
  checkPermission(): Promise<PhotoLibraryPermissionResult>;
  getAllPhotos(): Promise<GetAllPhotosResult>;
  getPhoto(options: GetPhotoOptions): Promise<GetPhotoResult>;
  releasePhoto(options: { id: string }): Promise<void>;
  releaseAllPhotos(): Promise<void>;
}
