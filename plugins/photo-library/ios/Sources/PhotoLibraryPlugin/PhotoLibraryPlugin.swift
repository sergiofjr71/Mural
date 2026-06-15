import Foundation
import Capacitor
import Photos
import UIKit

@objc(PhotoLibraryPlugin)
public class PhotoLibraryPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PhotoLibraryPlugin"
    public let jsName = "PhotoLibrary"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getAllPhotos", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPhoto", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "releasePhoto", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "releaseAllPhotos", returnType: CAPPluginReturnPromise),
    ]

    private let imageManager = PHCachingImageManager()
    private let ioQueue = DispatchQueue(label: "com.sergiofjr71.mural.photolibrary.io", qos: .userInitiated)
    private let cacheFolderName = "mural-photo-cache"

    private var cacheDirectory: URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        let dir = base.appendingPathComponent(cacheFolderName, isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir
    }

    private func mapAuthorizationStatus(_ status: PHAuthorizationStatus) -> [String: Any] {
        let granted = status == .authorized || status == .limited
        let mapped: String
        switch status {
        case .authorized: mapped = "authorized"
        case .limited: mapped = "limited"
        case .denied: mapped = "denied"
        case .restricted: mapped = "restricted"
        case .notDetermined: mapped = "notDetermined"
        @unknown default: mapped = "unknown"
        }
        return ["granted": granted, "status": mapped]
    }

    @objc func requestPermission(_ call: CAPPluginCall) {
        if #available(iOS 14, *) {
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { status in
                call.resolve(self.mapAuthorizationStatus(status))
            }
        } else {
            PHPhotoLibrary.requestAuthorization { status in
                call.resolve(self.mapAuthorizationStatus(status))
            }
        }
    }

    @objc func checkPermission(_ call: CAPPluginCall) {
        let status: PHAuthorizationStatus
        if #available(iOS 14, *) {
            status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        } else {
            status = PHPhotoLibrary.authorizationStatus()
        }
        call.resolve(mapAuthorizationStatus(status))
    }

    @objc func getAllPhotos(_ call: CAPPluginCall) {
        let status: PHAuthorizationStatus
        if #available(iOS 14, *) {
            status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        } else {
            status = PHPhotoLibrary.authorizationStatus()
        }

        guard status == .authorized || status == .limited else {
            call.reject("Photo library permission not granted")
            return
        }

        ioQueue.async {
            let options = PHFetchOptions()
            options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
            options.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)

            let assets = PHAsset.fetchAssets(with: .image, options: options)
            var photos: [[String: Any]] = []
            photos.reserveCapacity(assets.count)

            assets.enumerateObjects { asset, _, _ in
                var item: [String: Any] = [
                    "id": asset.localIdentifier,
                    "width": asset.pixelWidth,
                    "height": asset.pixelHeight,
                ]
                if let date = asset.creationDate {
                    item["creationDate"] = ISO8601DateFormatter().string(from: date)
                } else {
                    item["creationDate"] = ""
                }
                photos.append(item)
            }

            DispatchQueue.main.async {
                call.resolve([
                    "photos": photos,
                    "total": photos.count,
                ])
            }
        }
    }

    @objc func getPhoto(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("Missing photo id")
            return
        }

        let maxWidth = CGFloat(call.getInt("maxWidth") ?? 2048)
        let maxHeight = CGFloat(call.getInt("maxHeight") ?? 2048)
        let quality = CGFloat(call.getFloat("quality") ?? 0.82)

        let status: PHAuthorizationStatus
        if #available(iOS 14, *) {
            status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        } else {
            status = PHPhotoLibrary.authorizationStatus()
        }

        guard status == .authorized || status == .limited else {
            call.reject("Photo library permission not granted")
            return
        }

        let fetch = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil)
        guard let asset = fetch.firstObject else {
            call.reject("Photo not found")
            return
        }

        let pixelWidth = CGFloat(asset.pixelWidth)
        let pixelHeight = CGFloat(asset.pixelHeight)
        let scale = min(1.0, maxWidth / max(pixelWidth, 1), maxHeight / max(pixelHeight, 1))
        let targetSize = CGSize(width: max(1, pixelWidth * scale), height: max(1, pixelHeight * scale))

        let options = PHImageRequestOptions()
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = true
        options.isSynchronous = false

        imageManager.requestImage(for: asset, targetSize: targetSize, contentMode: .aspectFit, options: options) { [weak self] image, info in
            guard let self = self else { return }

            if let cancelled = info?[PHImageCancelledKey] as? Bool, cancelled {
                return
            }
            if let error = info?[PHImageErrorKey] as? Error {
                call.reject("Failed to load photo: \(error.localizedDescription)")
                return
            }
            guard let image = image else {
                call.reject("Failed to load photo")
                return
            }

            self.ioQueue.async {
                let safeId = self.safeFileName(for: id)
                let fileURL = self.cacheDirectory.appendingPathComponent("\(safeId).jpg")

                guard let data = image.jpegData(compressionQuality: quality) else {
                    DispatchQueue.main.async {
                        call.reject("Failed to encode photo")
                    }
                    return
                }

                do {
                    try data.write(to: fileURL, options: .atomic)
                    let webPath = self.bridge?.portablePath(fromLocalURL: fileURL) ?? fileURL.absoluteString
                    DispatchQueue.main.async {
                        call.resolve([
                            "id": id,
                            "path": fileURL.path,
                            "webPath": webPath,
                            "width": Int(image.size.width * image.scale),
                            "height": Int(image.size.height * image.scale),
                        ])
                    }
                } catch {
                    DispatchQueue.main.async {
                        call.reject("Failed to cache photo: \(error.localizedDescription)")
                    }
                }
            }
        }
    }

    @objc func releasePhoto(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("Missing photo id")
            return
        }

        ioQueue.async {
            let fileURL = self.cacheDirectory.appendingPathComponent("\(self.safeFileName(for: id)).jpg")
            if FileManager.default.fileExists(atPath: fileURL.path) {
                try? FileManager.default.removeItem(at: fileURL)
            }
            DispatchQueue.main.async {
                call.resolve()
            }
        }
    }

    @objc func releaseAllPhotos(_ call: CAPPluginCall) {
        ioQueue.async {
            let dir = self.cacheDirectory
            if let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) {
                for file in files {
                    try? FileManager.default.removeItem(at: file)
                }
            }
            DispatchQueue.main.async {
                call.resolve()
            }
        }
    }

    private func safeFileName(for id: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        return id.unicodeScalars.map { allowed.contains($0) ? Character($0) : "_" }.map(String.init).joined()
    }
}
