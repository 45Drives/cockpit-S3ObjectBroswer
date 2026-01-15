export type EndpointConfig = {
	name: string;
    endpoint: string;
    region?: string;
    accessKeyId: string;
    secretAccessKey: string;
    useTls: boolean
  };

  export type ConnectionSummary = {
	id: string;
	name: string;
	endpoint: string;
	region?: string;
	useTls: boolean;
	updatedAt: string;
	lastUsedAt?: string;
  };
  
  export type BucketSummary = { 
    name: string; 
    creationDate?: string | null 
  };

  export type ObjectFolder = {
    type: "folder";
    prefix: string; // e.g. "photos/2024/"
    name: string;   // e.g. "2024"
  };

  export type S3Owner = {
    id?: string | null;
    displayName?: string | null;
  };

  export type ObjectFile = {
    type: "file";
    key: string;
    size: number;
    lastModified?: string | null;
  
    etag?: string | null;
    storageClass?: string | null;
  
    owner?: S3Owner | null;
  };
  
  
  export type ObjectRow = ObjectFolder | ObjectFile;
  
  export type ListObjectsResult = {
    prefix: string;
    folders: string[]; // CommonPrefixes as strings
    objects: ObjectFile[];
    isTruncated: boolean;
    nextContinuationToken?: string | null;
  };
    
  export type S3ObjectItem = {
    key: string;
    size: number;
    lastModified?: string | null;
  
    etag?: string | null;
    storageClass?: string | null;
  
    owner?: S3Owner | null;
    };
    
  
  export type ListObjectsResponse = {
    prefix: string;
    commonPrefixes: string[];
    contents: S3ObjectItem[];
    isTruncated: boolean;
    nextContinuationToken?: string | null;
  };
  
  export type ListObjectsCliResult = {
    ok: boolean;
    prefix?: string;
    commonPrefixes?: string[];
    contents?: S3ObjectItem[];
    isTruncated?: boolean;
    nextContinuationToken?: string | null;
    error?: string;
  };
  

  export type PresignGetCliResult =
  | { ok: true; url: string; expiresIn: number }
  | { ok: false; error?: string };

  export type ClipKind = "copy" | "cut";

  export type ClipItem =
    | { type: "file"; key: string; name: string }
    | { type: "folder"; prefix: string; name: string };
  
  export type ClipboardState = {
    kind: ClipKind | null;
    connectionId: string;
    bucket: string;
    items: ClipItem[];
    createdAt: number;
  };

  export type FolderRow = { type: "folder"; prefix: string; name: string };
  export type FileRow = {
    type: "file";
    key: string;
    name: string;
    size: number;
    lastModified?: string | null;

    etag?: string | null;
    storageClass?: string | null;

    ownerDisplayName?: string | null;
    ownerId?: string | null;

    fileType?: string | null; // derived from extension/mime guess
};
export type Row = FolderRow | FileRow;
export type ViewMode = "table" | "icons";
export type DeleteKind = "file" | "folder";
export type DownloadState = "running" | "done" | "failed" | "cancelexport ed";

export type DownloadJob = {
    id: string;           // jobId
    kind: "object" | "prefix-targz";
    name: string;         // filename or prefix
    bytes?: number;
    totalBytes?: number;
    state: DownloadState;
    error?: string;
    updatedAt?: number;
};


export type PasteStep = "queued" | "copying" | "done" | "failed" | "canceled";

export type PasteItem = {
    id: string;
    itemType: "file" | "folder";
    srcKey: string; // file key OR prefix
    dstKey: string; // file key OR prefix
    name: string;
    step: PasteStep;
    error?: string;
};


export type UploadStatus = "queued" | "uploading" | "done" | "failed" | "canceled";

export type UploadItem = {
    id: string;
    file: File;
    dstKey: string;
    bytes: number;
    status: UploadStatus;
    canceled: boolean;
    error?: string;
    cancel?: () => void;
};

export type TransferJobState = "running" | "done" | "failed";

export type TransferJob = {
  id: string;
  kind: "copy" | "move";
  itemType: "file" | "folder";
  name: string;
  src: string; // srcKey or srcPrefix
  dst: string; // dstKey or dstPrefix
  state: TransferJobState;
  error?: string;
  startedAt: number;
  finishedAt?: number;
};
