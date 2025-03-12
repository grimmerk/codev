export class DeleteXwinDto {
  path: string;
}

export class CreateXwinDto {
  paths: string[];
  workspace_path: string;

  /* should always false since there is no way found to detect close/deactivate window event) */
  // deactivate = false;
}
