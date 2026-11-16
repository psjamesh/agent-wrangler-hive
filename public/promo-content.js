export const PROMO = {
  contentVersion: 1,
  changes: [],
  pages: [
    {
      id: 'welcome', label: 'Welcome', title: 'Give your work a home',
      text: 'A hive brings a goal, its agents and their decisions into one place. The queen keeps the work organised while you steer the outcome.',
      caption: 'One hive is one Agent Wrangler task, with a shared work record.',
      alt: 'All hives showing the fictional Launch a field guide task and its goal.',
      next: 'Explore the map',
    },
    {
      id: 'map', label: 'Map', title: 'See the work and what it needs',
      text: 'Each bead is a piece of work with an owner and a clear finish. Open it for the summary and evidence. Links show what must happen first.',
      caption: 'Select a bead for its record. Nearby hexagons do not imply a dependency.',
      alt: 'Build search selected in a demo map; Publish the guide waits for two prerequisites.',
      next: 'Meet the agents',
    },
    {
      id: 'people', label: 'People', title: 'A queen coordinates. Workers own the work.',
      text: 'The queen maintains the plan and brings decisions to you. Workers take bounded beads; reviewers examine their results. The record stays with the hive when a session changes.',
      caption: 'The owner and attached sessions tell you who is doing what. An idle session does not mean its bead is finished.',
      alt: 'Guide coordinator, Search builder and Reviewer attached to the fictional guide work.',
      next: 'Visit the inbox',
    },
    {
      id: 'inbox', label: 'Inbox', title: 'Keep the conversation with the work',
      text: 'The inbox brings Hive conversations together. Open a topic to read the context, follow a linked bead and reply to the queen. Unread messages and requests waiting on you are different things.',
      caption: 'Read and reply in context. Use Answer request when a decision needs your answer.',
      alt: 'Demo inbox with a field-guide topic, a linked Plan the launch event bead and a conversation reply.',
      next: 'See what needs you',
    },
    {
      id: 'needs-you', label: 'Needs you', title: 'Step in where it matters',
      text: 'A person mark points to work waiting on you. Open the request, read the choices and send your answer. The queen handles worker questions first and forwards the ones that need you.',
      caption: 'Answer request settles the question; a conversation reply alone does not. If there is no available queen, requests can come directly to you.',
      alt: 'Choose the cover with a person mark and a request offering Meadow, Hedgerow and Foxglove cover choices.',
      next: 'Follow delivery',
    },
    {
      id: 'delivery', label: 'Delivery', title: 'Follow the result, with evidence',
      text: 'A bead keeps its review, checks and delivery evidence together. Open the linked pull request or result to inspect it. Work closes when its agreed delivery boundary is met.',
      caption: 'Reviewed, merged and running are different facts. This demo shows one repository’s delivery agreement.',
      alt: 'Completed Build search record with review, test and merge evidence, and a separate installation obligation.',
      next: 'Close intro',
    },
  ],
};
