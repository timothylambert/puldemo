const S3 = require("aws-sdk").S3;
const unzipper = require("unzipper");
const mime = require("mime-types");

const sinkBucket = process.env.SINK_BUCKET;
const s3 = new S3({ apiVersion: "2006-03-01" });

const handler = async (event) => {

  try {
    const sourceBucket = event.detail.requestParameters.bucketName;
    const fileKey = event.detail.requestParameters.key;
    const promises = [];

    const zip = s3.getObject({ Bucket: sourceBucket, Key: fileKey })
      .createReadStream()
      .on("error", async (e) => console.log(`Error extracting file: `, e))
      .pipe(unzipper.Parse({ forceStream: true }));

    for await (const entry of zip) {
      const fileName = entry.path;
      const type = entry.type;

      if (type === "File") {
        const entryMimeType = mime.lookup(fileName);
        const uploadParams = {
          Bucket: sinkBucket,
          Key: `${type}/${fileName}`,
          Body: entry,
          ContentType: entryMimeType
        }

        promises.push(s3.upload(uploadParams).promise())
      } else {
        entry.autodrain();
      }
    }

    await Promise.all(promises);

  } catch (error) {
    console.log(`It's all gone pete tong: ${error}`);
  }
};

exports.handler = handler;