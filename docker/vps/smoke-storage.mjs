import { DeleteObjectCommand, ListObjectVersionsCommand } from "@aws-sdk/client-s3";

/** Delete only the disposable smoke key, including every version and marker. */
export async function deleteSmokeObject(s3, bucket, key) {
  const versions = [];
  let keyMarker;
  let versionMarker;
  for (;;) {
    let page;
    try {
      page = await s3.send(new ListObjectVersionsCommand({
        Bucket: bucket, Prefix: key, KeyMarker: keyMarker, VersionIdMarker: versionMarker,
      }));
    } catch (error) {
      if (error?.name !== "NotImplemented" && error?.Code !== "NotImplemented" && error?.$metadata?.httpStatusCode !== 501) throw error;
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      return;
    }
    const entries = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])];
    for (const entry of entries) {
      if (entry.Key !== key) continue;
      if (!entry.VersionId) throw new Error("Smoke object version id is missing.");
      versions.push(entry.VersionId);
    }
    if (!page.IsTruncated || entries.some((entry) => entry.Key !== key)) break;
    if (!page.NextKeyMarker || (page.NextKeyMarker === keyMarker && page.NextVersionIdMarker === versionMarker)) {
      throw new Error("Smoke object versions listing did not advance.");
    }
    keyMarker = page.NextKeyMarker;
    versionMarker = page.NextVersionIdMarker;
  }
  // Collect pages before deleting, so pagination markers stay valid.
  for (const versionId of versions) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
  }
}
