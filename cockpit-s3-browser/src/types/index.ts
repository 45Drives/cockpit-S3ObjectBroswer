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

  export type ObjectFile = {
    type: "file";
    key: string;
    size: number;
    lastModified?: string | null;
  
    etag?: string | null;
    storageClass?: string | null;
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
  | { type: "file"; name: string; key: string; bucket: string }
  | { type: "folder"; name: string; prefix: string; bucket: string };

  
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
    fileType?: string | null; // derived from extension/mime guess
};
export type Row = FolderRow | FileRow;
export type ViewMode = "table" | "icons";
export type DeleteKind = "file" | "folder";
export type DownloadState = "running" | "done" | "failed" | "canceled" | "canceling";

export type DownloadJob = {
    id: string;           // jobId
    kind: "object" | "prefix-targz" | "object-version" ;
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
  srcBucket: string;
  srcKey: string; // key or prefix
  dstKey: string; // key or prefix
  name: string;
  step: "queued" | "copying" | "done" | "failed" | "canceled";
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

export type TransferJobState = "running" | "done" | "failed" | "canceling" | "canceled";;

export type TransferJob = {
  id: string;
  kind: "copy" | "move";
  itemType: "file" | "folder";
  name: string;
  src: string;
  dst: string;
  state: TaskState;
  error?: string;
  startedAt: number;
  finishedAt?: number;
};

export type TagKV = { key: string; value: string };
export type TagMap = Record<string, string>;

export type TaskKind = "delete" | "download" | "upload" | "copy" | "move" | "rename" | "transfer";

export type TaskState = "running" | "canceling" | "done" | "failed" | "canceled";

export type TaskActions = {
  cancel?: () => void;
  dismiss?: () => void;
};

export type UiTask = {
  id: string;
  kind: TaskKind;
  name: string;
  state: TaskState;
  progressText?: string;
  progressPct?: number | null; // 0..100, null/undefined = no bar
  error?: string;
  actions?: TaskActions;
};


export type ObjectVersionItem = {
  key: string;
  versionId: string | null;
  isLatest: boolean;
  lastModified: string | null;
  size: number;
  etag: string | null;
};

export type GetObjectVersionsCliResult = {
  ok: boolean;
  versions?: Array<{
    key?: string;
    versionId?: string | null;
    isLatest?: boolean;
    lastModified?: string | null;
    size?: number;
    etag?: string | null;
  }>;
  error?: string;
};


export type Stat = {
  size: number;
lastModified: string | null;
etag: string | null;
storageClass: string | null;
metadata?: Record<string, string>;
legalHold: "ON" | "OFF" | null;
retentionMode: string | null;
retainUntil: string | null;
};
export type VersionItem = {
  versionId: string | null;
  isLatest: boolean;
  lastModified: string | null;
  size: number;
  etag: string | null;
};


export type VersionRow = {
  kind: "version";
  __key: string;
  key: string;
  name: string;
  versionId: string;
  isLatest: boolean;
  lastModified: string | null;
  size: number;
  etag: string | null;
  storageClass: string | null;
};

export type RateStats = {
  lastT: number;
  lastB: number;
  rateAvg: number | null; 
  etaSec: number | null; 
};

export type MenuMode = "objects" | "versions";

export type MenuAction =
  | "download"
  | "delete"
  | "rename"
  | "copy"
  | "paste"
  | "cut"
  | "tags"
  | "storageClass"
  | "rollback";

export type MenuPos = { x: number; y: number };