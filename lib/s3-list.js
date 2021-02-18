require("dotenv").config();
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const axios = require("axios");
const { sortBy, find, last, dropRight } = require("lodash");
const envs = require("./envs");

const client = new S3Client({
  region: process.env["EYEBROWSE_S3_REGION"],
  credentials: {
    accessKeyId: process.env["EYEBROWSE_S3_ACCESS_KEY"],
    secretAccessKey: process.env["EYEBROWSE_S3_SECRET_ACCESS_KEY"],
  },
});

/**
 * Get a list of all objects in the bucket.  If there are more than 1,000
 * objects, a series of API requests will be made and the results combined,
 * until all objects have been listed.
 *
 * @param {Function} transformer a function that can be run to transform the response received from S3.
 */
async function listObjects() {
  let objects = [];
  let continueListing = true; // should we keep fetching?
  let ContinuationToken; // what's the continuation token to use in the next pass?

  const MaxKeys = 1000;

  console.log(`[START] fetch new records from s3`);

  while (continueListing) {
    const listObjCmd = new ListObjectsV2Command({
      Bucket: process.env["EYEBROWSE_S3_BUCKET_NAME"],
      ContinuationToken,
      MaxKeys,
      // Delimiter: "/",
      // Prefix: "ppc64le/"
    });

    const data = await client.send(listObjCmd);

    // add the contents to the running list
    objects.push(...data.Contents);

    // determine if we need to keep listing; save the continuation token.
    if (data.IsTruncated) {
      console.log(`  fetched ${MaxKeys} records from s3 and going back for more...`);
      ContinuationToken = data.NextContinuationToken;
    } else {
      continueListing = false;
      console.log(`  fetched ${data.Contents.length} records from s3`);
    }
  }

  console.log(`[FINISH] fetch new records from s3`);

  console.log(objects);
  console.log(`[START] remove directories from s3 results (we'll infer them later)`);
  objects = objects.filter(f => f.Size !== 0);
  console.log(`[FINISH] remove directories from s3 results (we'll infer them later)`);

  console.log(`[START] convert s3 objects to Eyebrowse file schema`);
  objects = await Promise.all(objects.map(toFileSchema));
  console.log(`[FINISH] converting objects to Eyebrowse file schema`);

  // add dirs that are missing but we can infer to exist based on file paths within then (thanks S3...)
  console.log(`[START] infer existence of unreported dirs`);
  objects.push(...listDirs(objects));
  console.log(`[FINISH] infer existence of unreported dirs`);

  if (envs.displayHiddenFiles) {
    console.log(`[START] removing hidden files`);
    objects = objects.filter(f => !f.name.startsWith('.'));
    console.log(`[FINISH] removing hidden files`);
  }
  else {
    console.log(`[INFO] _not_ removing hidden files, configuration says to include them`);
  }

  // resolve symlinks
  console.log(`[START] resolving symlinks`);
  objects = await Promise.all(objects.map(resolveSymlink));
  console.log(`[FINISH] resolving symlinks`);

  return objects;
}

/**
 * Look for trailing slash in filename and path, and if found, remove it and set dir:true.
 *
 * S3 reports dirs with a trailing slash, but Eyebrowse wants the trailing
 * slash dropped and a dir:true flag set.
 */
function flagDir(fileIn) {
  let file = {...fileIn};
  const trailingSlash = /\/$/;

  if (trailingSlash.test(file.name)) {
    file.name = file.name.replace(trailingSlash, "");
    file.dir = true;
  }

  if (trailingSlash.test(file.path)) {
    file.path = file.path.replace(trailingSlash, "");
    file.dir = true;
  }

  return file;
}

/**
 * Insert directory objects.  Since S3 lists folders, but only _some_ folders and not others (unsure why),
 * this fills in the missing directory objects.  I think directories created
 * directly in S3 are listed, but ones that were created indirectly (by
 * uploading a zip file with dirs for example) do not.
 */
function listDirs(fileObjects) {
  // sort by parent in order to ensure we go from shorter paths to longer ones
  // (guaranteeing a later path never overwrites earlier one).
  const inferredDirs = [];
  const inferredDirLookup = {};

  sortBy(fileObjects, "parent").forEach(file => {
    if (!file.parent) return;

    const dirs = file.parent.split(/\//g)

    for(const [i] of dirs.entries()) {

      // take a slice of the array from 0..i
      const accDirs = dirs.slice(0, i+1)
      const dirPath = accDirs.join("/");
      const name = last(accDirs);

      // if it doesn't already exist in the file list from S3, or in the list
      // of inferred dirs already underway.
      if (!inferredDirLookup[dirPath] ) {
      // create an inferredDir for it
        inferredDirs.push({
          name,
          path: dirPath,
          parent: dropRight(accDirs).join("/"),
          size: null,
          lastModified: null,
          lastCached: null,
          dir: true,
        });
        inferredDirLookup[dirPath] = true;
      }
    }
  });

  return inferredDirs;
}

/**
 * Given an S3 object (from .Contents[]), fetch it and return the path to the
 * file it's linking to.  Adds a new .Target property, and mutates the Key (to
 * remove 'link__')
 */
async function resolveSymlink(file, key, array) {
  // if the obj isn't a "symlink", just return the filepath (.Key)
  if (!file.name.startsWith("link__")) {
    return file;
  }

  // object is a "symlink", so fetch its contents and return them
  const url = getS3ObjectUrl(file);
  try {
    const response = await axios.get(url, { responseType: "text" });
    const targetName = response.data.split("\n")[0].trim();
    const targetObj = find(array, { path: targetName }) || {};

    file.target = targetName;

    // copy a few of the target's fields into the link.  if the target is a
    // "folder", no values will be copied in, so fall back to the link's
    // values.
    file.size = targetObj.size || file.size;
    file.lastModified = targetObj.lastModified || file.lastModified;
    file.dir = targetObj.dir || file.dir;

    // remove the link__ prefix from the "filename"
    file.name = file.name.replace("link__", "");
  } catch (e) {
    console.error(e);
  }

  // fetching the "symlink" target failed; return the original path as
  // a fallback
  return file;
}

/**
 * Return the public URL of an S3 object.
 */
function getS3ObjectUrl(file) {
  return `https://${envs.bucketName}.s3.amazonaws.com/${file.path}`;
}

/**
 * Transform an S3 object (from .Contents) to an object that matches the
 * Eyebrowse File schema.
 */
function toFileSchema(s3obj) {
  const trailingSlash = /\/$/;
  const pathArray = s3obj.Key.replace(trailingSlash, "").split("/");
  return {
    name: last(pathArray) || s3obj.Key,
    path: pathArray.join("/"),
    parent: dropRight(pathArray).join("/"),
    target: s3obj.Target,
    size: s3obj.Size,
    lastModified: s3obj.LastModified.toUTCString(),
    lastCached: new Date().toUTCString(),
    dir: trailingSlash.test(s3obj.Key),
  };
}

module.exports = { listDirs, listObjects, resolveSymlink, toFileSchema };

// If run standalone, simply print the contents of the bucket.
if (require.main === module) {
  async function main() {
    try {
      const objs = await listObjects([resolveSymlink, toFileSchema]);
      console.log(objs);
      console.log(listDirs(objs));
    } catch (error) {
      console.error(error);
    } finally {
      console.log("done");
    }

  }
  main();
}
