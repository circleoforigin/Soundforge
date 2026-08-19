import { githubSettings } from './GitHubSettings.ts';

interface GitHubFileInfo {
  sha: string;
}

interface GitHubFileContent {
  sha: string;
  content: string;
}

export class GitHubFileClient {
  async getFileInfo(
    path: string
  ): Promise<GitHubFileInfo | null> {
    const url =
      `https://api.github.com/repos/` +
      `${githubSettings.owner}/` +
      `${githubSettings.repo}/contents/` +
      `${path}` +
      `?ref=${githubSettings.branch}`;

    const response = await fetch(url, {
      headers: this.getHeaders(),
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(
        `GitHub read failed: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json() as {
      sha: string;
    };

    return {
      sha: data.sha,
    };
  }

  async readTextFile(
    path: string
  ): Promise<string | null> {
    const url =
      `https://api.github.com/repos/` +
      `${githubSettings.owner}/` +
      `${githubSettings.repo}/contents/` +
      `${path}` +
      `?ref=${githubSettings.branch}`;

    const response = await fetch(url, {
      headers: this.getHeaders(),
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(
        `GitHub read failed: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json() as GitHubFileContent;

    const normalizedBase64 =
      data.content.replace(/\n/g, '');

    return Buffer
      .from(normalizedBase64, 'base64')
      .toString('utf8');
  }

  async writeFile(
    path: string,
    content: Uint8Array,
    commitMessage: string
  ): Promise<void> {
    const existingFile =
      await this.getFileInfo(path);

    const url =
      `https://api.github.com/repos/` +
      `${githubSettings.owner}/` +
      `${githubSettings.repo}/contents/` +
      `${path}`;

    const base64Content =
      Buffer.from(content).toString('base64');

    const body: {
      message: string;
      content: string;
      branch: string;
      sha?: string;
    } = {
      message: commitMessage,
      content: base64Content,
      branch: githubSettings.branch,
    };

    if (existingFile) {
      body.sha = existingFile.sha;
    }

    const response = await fetch(url, {
      method: 'PUT',

      headers: this.getHeaders(),

      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText =
        await response.text();

      throw new Error(
        `GitHub write failed: ${response.status} ${errorText}`
      );
    }
  }

  private getHeaders(): Record<string, string> {
    if (!githubSettings.token) {
      throw new Error(
        'GITHUB_TOKEN is not configured.'
      );
    }

    return {
      Accept: 'application/vnd.github+json',

      Authorization:
        `Bearer ${githubSettings.token}`,

      'X-GitHub-Api-Version': '2022-11-28',

      'Content-Type': 'application/json',
    };
  }
}