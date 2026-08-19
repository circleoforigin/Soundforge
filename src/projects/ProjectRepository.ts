import type { Project } from '../models/Project';

import {
  localStorageService,
} from '../storage/LocalStorageService';

const PROJECTS_KEY = 'projects';

export class ProjectRepository {
  loadProjects(): Project[] {
    const projects =
      localStorageService.get<Project[]>(
        PROJECTS_KEY,
        []
      );

    return Array.isArray(projects)
      ? projects
      : [];
  }

  saveProjects(
    projects: Project[]
  ): void {
    localStorageService.set(
      PROJECTS_KEY,
      projects
    );
  }

  saveProject(
    project: Project
  ): Project[] {
    const projects =
      this.loadProjects();

    const exists =
      projects.some(
        (candidate) =>
          candidate.id === project.id
      );

    const updatedProjects =
      exists
        ? projects.map(
            (candidate) =>
              candidate.id === project.id
                ? project
                : candidate
          )
        : [
            ...projects,
            project,
          ];

    this.saveProjects(
      updatedProjects
    );

    return updatedProjects;
  }

  deleteProject(
    projectId: string
  ): Project[] {
    const updatedProjects =
      this.loadProjects().filter(
        (project) =>
          project.id !== projectId
      );

    this.saveProjects(
      updatedProjects
    );

    return updatedProjects;
  }
}

export const projectRepository =
  new ProjectRepository();