import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import * as Crypto from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { bytesFromBase64, RECEIPT_MAX_EDGE, RECEIPT_QUALITY, toHex, type ClaimReceipt } from "./claimForm";

/**
 * Taking or choosing a receipt photo, shrinking it, and keeping it on the phone
 * until it has been uploaded (the claim outbox sends it, see hooks/useTimeQueue).
 *
 * A phone photo is several megabytes; a receipt is read at a fraction of that.
 * It is scaled to RECEIPT_MAX_EDGE on its long side and saved as JPEG, which
 * keeps it to a few hundred kilobytes, and its SHA-256 is taken from the exact
 * bytes kept, so the desktop can tell the file it shows is the file filed.
 */

export type ReceiptSource = "camera" | "library";
export type ReceiptFailure = "permission" | "cancelled" | "failed";
export type PickedReceipt = { ok: true; receipt: ClaimReceipt } | { ok: false; reason: ReceiptFailure };

/** A folder inside the app's own documents, which the system does not clear. */
const folder = () => new Directory(Paths.document, "claim-receipts");

const fileFor = (claimUuid: string) => new File(folder(), `${claimUuid}.jpg`);

export async function pickReceipt(source: ReceiptSource, claimUuid: string): Promise<PickedReceipt> {
  try {
    if (source === "camera") {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) return { ok: false, reason: "permission" };
    }
    const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 1, allowsEditing: false };
    const picked =
      source === "camera" ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
    if (picked.canceled || !picked.assets[0]) return { ok: false, reason: "cancelled" };
    const asset = picked.assets[0];

    // Scale the long side down to RECEIPT_MAX_EDGE; never enlarge a small photo.
    const longSide = Math.max(asset.width, asset.height);
    const resize = longSide > RECEIPT_MAX_EDGE ? (asset.width >= asset.height ? { width: RECEIPT_MAX_EDGE } : { height: RECEIPT_MAX_EDGE }) : null;
    const shrunk = await ImageManipulator.manipulateAsync(asset.uri, resize ? [{ resize }] : [], {
      compress: RECEIPT_QUALITY,
      format: ImageManipulator.SaveFormat.JPEG,
      base64: true,
    });
    const bytes = shrunk.base64 ? bytesFromBase64(shrunk.base64) : null;
    if (!bytes || bytes.length === 0) return { ok: false, reason: "failed" };

    const sha256 = toHex(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes));
    folder().create({ idempotent: true, intermediates: true });
    const file = fileFor(claimUuid);
    file.create({ overwrite: true });
    file.write(bytes);
    return { ok: true, receipt: { path: file.uri, sha256, sizeBytes: bytes.length } };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/** The kept photo's bytes, for uploading. Throws if the file is gone. */
export async function readReceipt(path: string): Promise<Uint8Array> {
  return new File(path).bytes();
}

/** Removes a photo that will not be uploaded (the form was cancelled, or it was sent long ago). */
export function deleteReceipt(path: string): void {
  try {
    const file = new File(path);
    if (file.exists) file.delete();
  } catch {
    // Already gone: nothing to remove.
  }
}
