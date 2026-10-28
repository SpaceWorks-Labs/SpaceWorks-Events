import type { HelpSectionEntry } from "../manifest";

export const hackathons = {
  id: "hackathons",
  title: "Hackathons and judging",
  description: "Take project submissions, judge them against a rubric, publish results and pay out prizes.",
  access: "public",
  articles: [
    { slug: "hackathons/overview", title: "Running a hackathon", summary: "How submissions, judging, results and prizes fit together." },
    { slug: "hackathons/submissions", title: "Submissions and the gallery", summary: "The submission window, reviewing projects, and the public gallery." },
    { slug: "hackathons/entry-fees", title: "Project entry fees", summary: "Charge a fee when a team or solo entrant submits a project." },
    { slug: "hackathons/judging", title: "Judges, rubric and scoring", summary: "Invite judges, build the rubric, and score projects." },
    { slug: "hackathons/progress", title: "Assigning judges and tracking progress", summary: "Spread projects across judges and spot reviews that need attention." },
    { slug: "hackathons/rounds", title: "Judging in rounds", summary: "Judge in stages, each round with its own rubric and judges." },
    { slug: "hackathons/finalists", title: "Finalists", summary: "Advance the best projects to the next round and announce them." },
    { slug: "hackathons/mentor-desk", title: "Setting up the Mentor Desk", summary: "Mentors, help categories, assignments, office hours and mentoring rounds." },
    { slug: "hackathons/mentor-console", title: "Mentoring at an event", summary: "The mentor console: the help queue, your teams, office hours and round visits." },
    { slug: "hackathons/getting-help", title: "Getting help from a mentor", summary: "Ask for help, follow your request and book office hours as a participant." },
    { slug: "hackathons/results", title: "Awards and results", summary: "Rank projects, give awards and publish the results page." },
    { slug: "hackathons/prize-payouts", title: "Prize payouts", summary: "Record prize money for winners and track what has been paid." },
  ],
} as const satisfies HelpSectionEntry;
