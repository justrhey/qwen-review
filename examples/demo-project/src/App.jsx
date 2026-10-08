import { ReviewCard } from "./components/ReviewCard";
import { summarize } from "./review";
export default function App() { return <ReviewCard title={summarize("local changes")} />; }
