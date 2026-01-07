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
