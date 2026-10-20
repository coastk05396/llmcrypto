import { RepositoryGraph } from "./pages/RepositoryGraph";
import { Design } from "./pages/Design";
import { Audit } from "./pages/Audit";
import { Operations } from "./pages/Operations";
import { Route, Routes } from "react-router";
import { ConsoleLayout } from "./components/ConsoleLayout";
import { Layout } from "./components/Layout";
import { AgentRuns } from "./pages/AgentRuns";
import { Connectivity } from "./pages/Connectivity";
import { ContextSteering } from "./pages/ContextSteering";
import { More } from "./pages/More";
import { ProjectMemory } from "./pages/ProjectMemory";
import { Tuning } from "./pages/Tuning";
import { FullSessionOnly as Full } from "./components/Restricted";
import { Credits } from "./pages/Credits";
import { RequestDetail } from "./pages/RequestDetail";
import { Usage } from "./pages/Usage";
import { Diagnostics } from "./pages/Diagnostics";
import { Docs } from "./pages/Docs";
import { Home } from "./pages/Home";
import { Keys } from "./pages/Keys";
import { NotFound } from "./pages/NotFound";
import { Overview } from "./pages/Overview";
import { Security } from "./pages/Security";
import { Setup } from "./pages/Setup";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="setup" element={<Setup />} />
        <Route path="diag" element={<Diagnostics />} />
        <Route path="docs" element={<Docs />} />
        <Route path="*" element={<NotFound />} />
      </Route>
      <Route path="app" element={<ConsoleLayout />}>
        <Route index element={<Full index><Overview /></Full>} />
        <Route path="usage" element={<Usage />} />
        <Route path="usage/agent-runs" element={<AgentRuns />} />
        <Route path="usage/:id" element={<RequestDetail />} />
        <Route path="credits" element={<Full><Credits /></Full>} />
        <Route path="keys" element={<Full><Keys /></Full>} />
        <Route path="security" element={<Full><Security /></Full>} />
        <Route path="tuning" element={<Full><Tuning /></Full>} />
        <Route path="context" element={<Full><ContextSteering /></Full>} />
        <Route path="memory" element={<Full><ProjectMemory /></Full>} />
        <Route path="connectivity" element={<Full><Connectivity /></Full>} />
        <Route path="repository" element={<Full><RepositoryGraph /></Full>} />
        <Route path="design" element={<Full><Design /></Full>} />
        <Route path="audit" element={<Full><Audit /></Full>} />
        <Route path="operations" element={<Full><Operations /></Full>} />
        <Route path="more" element={<Full><More /></Full>} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
