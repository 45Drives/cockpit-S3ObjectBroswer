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