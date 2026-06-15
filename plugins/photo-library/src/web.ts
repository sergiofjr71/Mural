import { WebPlugin } from '@capacitor/core';
import type {
  GetAllPhotosResult,
  GetPhotoOptions,
  GetPhotoResult,
  PhotoLibraryPermissionResult,
  PhotoLibraryPlugin,
} from './definitions';

export class PhotoLibraryWeb extends WebPlugin implements PhotoLibraryPlugin {
  async requestPermission(): Promise<PhotoLibraryPermissionResult> {
    return { granted: false, status: 'denied' };
  }

  async checkPermission(): Promise<PhotoLibraryPermissionResult> {
    return { granted: false, status: 'denied' };
  }

  async getAllPhotos(): Promise<GetAllPhotosResult> {
    return { photos: [], total: 0 };
  }

  async getPhoto(_options: GetPhotoOptions): Promise<GetPhotoResult> {
    throw this.unavailable('PhotoLibrary is only available on iOS.');
  }

  async releasePhoto(): Promise<void> {
    return;
  }

  async releaseAllPhotos(): Promise<void> {
    return;
  }
}
