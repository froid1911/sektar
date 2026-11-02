import type { DocumentNode } from "graphql";
import { gql } from "graphql-tag";

export const schema: DocumentNode = gql`
  type FilesTag {
    id: String!
    label: String!
    color: String!
  }

  """
  One entry of a folder listing: the drive node, and what the File document
  it names says about itself. Lean on purpose; the File is loaded when opened.
  """
  type FilesRow {
    id: String!
    """folder | file"""
    kind: String!
    name: String!
    parentId: String
    documentType: String
    title: String
    description: String
    tags: [FilesTag!]!
    sourceKind: String
    sourceMime: String
    sourceName: String
    sourceSize: Float
    sourceDocumentType: String
    sourceDocumentName: String
    renditionCount: Int!
    thumbRef: String
    "A change a folder sync found on disk, waiting to be pulled: CREATE | UPDATE | DELETE"
    diskChange: String
  }

  type FilesPage {
    items: [FilesRow!]!
    """Every entry the listing covers, not just this page."""
    total: Int!
  }

  """A folder of the tree, with what it holds directly."""
  type FilesFolder {
    id: String!
    name: String!
    parentId: String
    """Every entry directly in it"""
    items: Int!
    """The folders among them"""
    folders: Int!
    """The documents among them"""
    files: Int!
  }

  type FilesFolderTree {
    """Every folder but the folder syncs' own, by name"""
    folders: [FilesFolder!]!
    rootItems: Int!
    rootFolders: Int!
    """The root folder the folder syncs are kept in"""
    syncFolderId: String
  }

  type FilesSyncRun {
    startedAt: String
    finishedAt: String
    status: String
    placeholders: Int!
    error: String
  }

  """A folder sync filed in the drive, as its badge shows it. The document is loaded when opened."""
  type FilesSyncMapping {
    id: String!
    name: String!
    driveId: String
    folderId: String
    folderPath: String
    localPath: String
    enabled: Boolean!
    """MANUAL | ON_CHANGE"""
    trigger: String!
    includeSubfolders: Boolean!
    """NEVER | REQUESTED | RUNNING | OK | PARTIAL | ERROR"""
    status: String!
    requestedAt: String
    lastRun: FilesSyncRun
    issueCount: Int!
    pullCount: Int!
    hostName: String
  }

  type FilesIndexQueries {
    """
    A page of a folder (the root when folderId is null), folders first, then
    by name. Deep, the folder and every folder below it, documents only.
    query is a word search over names, titles, descriptions, tags and sources;
    a deep search finds the folders that match as well.
    """
    listing(
      driveId: String!
      folderId: String
      deep: Boolean = false
      query: String
      offset: Int = 0
      limit: Int = 60
      """Group by sync status: the changes a folder sync found on disk come first."""
      syncFirst: Boolean = false
    ): FilesPage!
    """The drive's folders with what each holds directly: the tree, its counts and paths."""
    folders(driveId: String!): FilesFolderTree!
    """The folder syncs filed in the drive, with how each stands."""
    syncMappings(driveId: String!): [FilesSyncMapping!]!
  }

  type Query {
    filesIndex: FilesIndexQueries!
  }
`;
