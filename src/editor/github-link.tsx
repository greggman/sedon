import octocat from '../assets/images/octocat-icon.svg';

export function GithubLink() {
  return (
    <div className="github-link">
      <a target="_blank" rel="noopener noreferrer" href="https://greggman.github.io/sedon">
        <img src={octocat} />
      </a>
    </div>
  );
}
